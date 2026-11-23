import { closeSync, openSync, readSync } from "node:fs";
import type { Command, EngineEvent, LocalFile } from "@navvied/protocol";
import type { ModelEntry } from "./config.ts";
import { planRun } from "./fit.ts";
import { readShape, readTemplate, templateTakesTools } from "./gguf.ts";
import { serverNote } from "./local-entry.ts";
import { reapOrphan, startServer, type RunningServer } from "./llama-server.ts";
import { localDir } from "./config.ts";
import type { IO } from "./io.ts";
import { readMachine, realProbe, type Machine, type Probe } from "./machine.ts";
import { askOllama, ollamaRoot, pullOllama, type OllamaPullState } from "./ollama-pull.ts";
import { recommendedModels, searchModels, type Candidate } from "./model-hub.ts";
import { MODEL_HUB, RECOMMENDED_MODELS, RUNTIME, RUNTIME_DRIVERS } from "./presets.ts";
import { cleanParts, installedModels, pathOf, pullModel, removeModel, type PullState } from "./model-files.ts";
import { installRuntime, removeRuntime, runtimeState, type Backend, type RuntimeState } from "./runtime.ts";

export interface LocalDeps {
  io: IO;
  /** Whether this session is Navvied Cloud: nothing here is done there, and nothing of the hardware is said. */
  inCloud(): boolean;
  /** The token saved for the model hub, when there is one. */
  hubToken(): string | undefined;
  /** The computer to plan with, when it is not the one this runs on (a test gives its own). */
  probe?(): Probe;
  /** Tells every window. */
  tell(e: EngineEvent): void;
  /** The model of the configuration that this computer's own server makes when it runs (it is in the list only while it runs); every window is told the list at once. */
  models: { add(name: string, entry: ModelEntry): void; refresh(): void };
}

const REFUSED = "A model is run only on a computer, never in Navvied Cloud.";

/** What the commands that are about running models on this computer do: the machine, the search, the runtime. */
export function localModels(d: LocalDeps): { command(cmd: Command): boolean; stop(): Promise<void>; running(): string | undefined } {
  const dir = (): string => localDir(d.io.env);
  const probe = (): Probe => d.probe?.() ?? realProbe(d.io.system);
  const machine = (): Promise<Machine> => readMachine(probe(), dir());
  const BACKENDS: readonly string[] = ["cpu", "vulkan", "cuda12", "cuda13", "metal"];
  const forced = (): Backend | undefined => { const b = d.io.env.NAVVIED_LOCAL_BACKEND; return b && BACKENDS.includes(b) ? (b as Backend) : undefined; };
  const stateOf = (m: Machine) => runtimeState(dir(), RUNTIME, m, RUNTIME_DRIVERS, forced());
  let job: AbortController | undefined;
  let state: RuntimeState | undefined;
  let running: { server: RunningServer; repo: string; file: string; name: string } | undefined;
  let starting = false;

  const wording = (s: RuntimeState): EngineEvent => {
    const base = { ev: "local.runtime" as const, state: s.state, version: RUNTIME.tag, server: running ? "running" as const : "stopped" as const };
    if (s.state === "installing" || s.state === "verifying") return { ...base, file: s.file, bytes: s.bytes, total: s.total };
    if (s.state === "failed") return { ...base, error: s.error };
    if (s.state === "ready") return { ...base, backend: s.backend };
    return base;
  };

  const tellRuntime = async (): Promise<void> => {
    if (job && state) { d.tell(wording(state)); return; }
    const m = await machine();
    const now = stateOf(m);
    // The last failure is said until the next attempt (or until the build turns out to be there).
    d.tell(wording(state?.state === "failed" && now.state !== "ready" ? state : now));
  };

  const install = async (): Promise<void> => {
    if (job) { d.tell(wording(state ?? { state: "none" })); return; }
    const m = await machine();
    const now = stateOf(m);
    if (now.state === "ready") { d.tell(wording(now)); return; }
    if (!now.asset) { state = { state: "failed", error: now.state === "failed" ? now.error : "There is no build of the runtime for this computer." }; d.tell(wording(state)); return; }
    job = new AbortController();
    const done = job;
    try {
      await installRuntime({
        pin: RUNTIME, asset: now.asset, local: dir(), fetchFn: d.io.fetch, platform: process.platform, signal: done.signal,
        run: (argv, timeoutMs) => d.io.system.run(argv, { timeoutMs }),
        freeBytes: () => { const disk = probe().disk(dir()); return disk ? disk.freeMb * 1048576 : undefined; },
        onState: (s) => { state = s; d.tell(wording(s)); },
      });
    } finally { job = undefined; }
  };

  const pulls = new Map<string, { controller?: AbortController; state: PullState; repo: string; file: string }>();
  const keyOf = (repo: string, file: string): string => `${repo}\n${file}`;
  const tellFile = (repo: string, file: string, s: PullState): void => {
    d.tell({ ev: "local.file", repo, file, state: s.state, ...("bytes" in s ? { bytes: s.bytes, total: s.total } : {}), ...("error" in s ? { error: s.error } : {}) });
  };
  const tools = (repo: string, file: string): boolean | undefined => { const at = pathOf(dir(), repo, file); return at ? toolsOf(at) : undefined; };
  const tellInstalled = (): void => {
    const done = installedModels(dir()).map((m) => ({ repo: m.repo, file: m.file, quant: m.quant, sizeMb: Math.ceil(m.sizeBytes / 1048576), ...(tools(m.repo, m.file) !== undefined ? { tools: tools(m.repo, m.file)! } : {}), state: (running?.repo === m.repo && running.file === m.file ? "running" : "done") as "done" | "running" }));
    const going = [...pulls.values()].flatMap((p) => (p.state.state === "done" || p.state.state === "idle" || done.some((x) => x.repo === p.repo && x.file === p.file) ? [] : [{ repo: p.repo, file: p.file, quant: "", sizeMb: "total" in p.state ? Math.ceil(p.state.total / 1048576) : 0, state: p.state.state, ...("bytes" in p.state ? { bytes: p.state.bytes, total: p.state.total } : {}), ...("error" in p.state ? { error: p.state.error } : {}) }]));
    d.tell({ ev: "local.installed", items: [...done, ...going] });
  };

  const pull = async (repo: string, file: string): Promise<void> => {
    const key = keyOf(repo, file);
    if (pulls.get(key)?.controller) { tellFile(repo, file, pulls.get(key)!.state); return; }
    const entry: { controller?: AbortController; state: PullState; repo: string; file: string } = { controller: new AbortController(), state: { state: "downloading", bytes: 0, total: 0 }, repo, file };
    pulls.set(key, entry);
    const token = d.hubToken();
    const result = await pullModel({
      hub: MODEL_HUB, repo, file, local: dir(), fetchFn: d.io.fetch, signal: entry.controller!.signal, ...(token ? { token } : {}),
      freeBytes: () => { const disk = probe().disk(dir()); return disk ? disk.freeMb * 1048576 : undefined; },
      onState: (s) => { entry.state = s; tellFile(repo, file, s); },
    });
    delete entry.controller;
    if (result.ok || result.why === "cancelled") pulls.delete(key);
    tellInstalled();
  };

  const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  /** The first bytes of a model file, as many as its header needs. */
  const headerOf = (path: string): ReturnType<typeof readShape> => {
    const fd = openSync(path, "r");
    try {
      for (const size of [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
        const buf = new Uint8Array(size);
        const n = readSync(fd, buf, 0, size, 0);
        const got = readShape(buf.subarray(0, n));
        if (!("more" in got) || n < size) return got;
      }
      return { error: "The header of the file is longer than is read." };
    } finally { closeSync(fd); }
  };

  const known = new Map<string, boolean | undefined>();
  /** Whether the chat template inside a file handles tools (the file is read once; a file that does not say, or cannot be read, says nothing). */
  const toolsOf = (path: string): boolean | undefined => {
    if (known.has(path)) return known.get(path);
    let found: boolean | undefined;
    try {
      const fd = openSync(path, "r");
      try {
        for (const size of [8 * 1024 * 1024, 64 * 1024 * 1024]) {
          const buf = new Uint8Array(size);
          const n = readSync(fd, buf, 0, size, 0);
          const got = readTemplate(buf.subarray(0, n));
          if ("template" in got) { found = templateTakesTools(got.template); break; }
          if ("error" in got || n < size) break;
        }
      } finally { closeSync(fd); }
    } catch { /* unreadable: nothing is said */ }
    known.set(path, found);
    return found;
  };

  const tellServer = (s: { state: "starting" | "running" | "stopped" | "failed"; repo?: string; file?: string; window?: number; layers?: number; error?: string }): void => {
    d.tell({ ev: "local.server", ...s });
  };

  const stopServer = async (): Promise<void> => {
    const was = running;
    if (!was) return;
    running = undefined;
    await was.server.stop();
    d.models.refresh();
    tellFile(was.repo, was.file, { state: "done", bytes: 0, total: 0 });
    tellServer({ state: "stopped", repo: was.repo, file: was.file });
    tellInstalled();
  };

  const run = async (repo: string, file: string, asked?: number): Promise<void> => {
    if (starting) return;
    starting = true;
    const fail = (error: string): void => { tellServer({ state: "failed", repo, file, error }); };
    try {
      const m = await machine();
      const rt = stateOf(m);
      if (rt.state !== "ready") { fail("The runtime is not fetched yet."); return; }
      const model = installedModels(dir()).find((x) => x.repo === repo && x.file === file);
      const path = pathOf(dir(), repo, file);
      if (!model || !path) { fail("That model is not on this computer."); return; }
      const shape = headerOf(path);
      if (!("shape" in shape)) { fail("error" in shape ? shape.error : "The file could not be read as a model."); return; }
      // The layers go to the card only if the build that runs has a card backend: a processor build (or the processor asked for) is planned as if the computer had no card.
      const plan = planRun(model.sizeBytes, shape.shape, rt.backend === "cpu" || forced() === "cpu" ? { ...m, gpus: [] } : m, asked);
      if ("error" in plan) { fail(plan.error); return; }
      await stopServer();
      tellServer({ state: "starting", repo, file, window: plan.window, layers: plan.layers });
      const stem = file.split("/").pop()!.replace(/-\d{5}-of-\d{5}\.gguf$/i, "").replace(/\.gguf$/i, "");
      const server = await startServer({ binary: rt.binary, model: path, window: plan.window, layers: plan.layers, alias: stem, pidFile: serverNote(dir()) });
      if ("error" in server) { fail(server.error); return; }
      const name = `local-${slug(repo.replace("/", "-"))}-${slug(stem)}`;
      running = { server, repo, file, name };
      d.models.add(name, { local: { repo, file, window: plan.window, ...(toolsOf(path) !== undefined ? { tools: toolsOf(path)! } : {}) }, model: stem, display: { name: stem } });
      tellFile(repo, file, { state: "running" });
      tellServer({ state: "running", repo, file, window: plan.window, layers: plan.layers });
      tellInstalled();
      void server.exited.then(() => {
        if (running?.server !== server) return;
        running = undefined;
        d.models.refresh();
        tellServer({ state: "stopped", repo, file });
        tellInstalled();
      });
    } finally { starting = false; }
  };

  const foundOf = (got: { items: Candidate[]; notes: string[] }): { items: LocalFile[]; notes?: string[] } => ({ items: got.items.map((f) => ({ repo: f.repo, page: `${MODEL_HUB.base}/${f.repo}`, file: f.file, quant: f.quant, sizeMb: Math.ceil(f.sizeBytes / 1048576), parts: f.parts.length, gated: f.gated, ...(f.tools !== undefined ? { tools: f.tools } : {}), ...(f.fit ? { fit: f.fit, needMb: f.needMb!, gpuLayers: f.gpuLayers!, window: f.contextLength! } : {}) })), ...(got.notes.length ? { notes: got.notes } : {}) });

  const ollamaPulls = new Map<string, AbortController>();
  const tellOllama = async (): Promise<void> => {
    const got = await askOllama(d.io.fetch, ollamaRoot(d.io.env));
    d.tell({ ev: "local.ollama", ...got });
  };
  const ollamaPull = async (model: string): Promise<void> => {
    const tellModel = (s: OllamaPullState): void => { d.tell({ ev: "local.ollama.model", model, ...s }); };
    if (ollamaPulls.has(model)) return;
    const controller = new AbortController();
    ollamaPulls.set(model, controller);
    try {
      const done = await pullOllama({ fetchFn: d.io.fetch, root: ollamaRoot(d.io.env), model, signal: controller.signal, onState: tellModel });
      if (done.ok) await tellOllama();
    } finally { ollamaPulls.delete(model); }
  };

  // A server that a program that crashed left behind is stopped (the model it made is not in the list while no server runs, so there is nothing else to take away).
  const cleaned = reapOrphan(serverNote(dir()), (argv) => d.io.system.run(argv, { timeoutMs: 5000 })).catch(() => undefined);

  return {
    async stop() { await cleaned; await stopServer(); },
    running: () => running?.name,
    command(cmd) {
      switch (cmd.cmd) {
        case "machine":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void machine().then((m) => d.tell({ ev: "machine", ...m }));
          return true;
        case "local.search": {
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          const token = d.hubToken();
          void (async () => {
            const got = await searchModels(d.io.fetch, MODEL_HUB, { query: cmd.query, window: cmd.window ?? 32_768, machine: await machine(), ...(token ? { token } : {}) });
            if ("error" in got) { d.tell({ ev: "error", msg: got.error }); return; }
            d.tell({ ev: "local.found", ...foundOf(got) });
          })();
          return true;
        }
        case "local.recommended": {
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          const token = d.hubToken();
          void (async () => {
            const got = await recommendedModels(d.io.fetch, MODEL_HUB, RECOMMENDED_MODELS.map((m) => m.repo), { window: cmd.window ?? 32_768, machine: await machine(), ...(token ? { token } : {}) });
            d.tell({ ev: "local.found", ...foundOf(got), recommended: true });
          })();
          return true;
        }
        case "local.runtime.remove":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          if (running || starting) { d.tell({ ev: "error", msg: "A model is running. Stop it first." }); return true; }
          if (job) { d.tell({ ev: "error", msg: "The runtime is being fetched. Cancel that first." }); return true; }
          removeRuntime(dir());
          state = undefined;
          void tellRuntime();
          return true;
        case "local.runtime":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void tellRuntime();
          return true;
        case "local.runtime.install":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void install();
          return true;
        case "local.runtime.cancel":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          job?.abort("cancel");
          return true;
        case "local.run":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void cleaned.then(() => run(cmd.repo, cmd.file, cmd.window));
          return true;
        case "local.stop":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void stopServer();
          return true;
        case "local.models":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          tellInstalled();
          return true;
        case "local.ollama":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void tellOllama();
          return true;
        case "local.ollama.pull":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          void ollamaPull(cmd.model);
          return true;
        case "local.ollama.cancel":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          ollamaPulls.get(cmd.model)?.abort("cancel");
          return true;
        case "local.pull":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          if (!pathOf(dir(), cmd.repo, cmd.file)) { d.tell({ ev: "error", msg: "That is not a file name that can be kept." }); return true; }
          void pull(cmd.repo, cmd.file);
          return true;
        case "local.pause":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          pulls.get(keyOf(cmd.repo, cmd.file))?.controller?.abort("pause");
          return true;
        case "local.cancel": {
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          const running = pulls.get(keyOf(cmd.repo, cmd.file));
          if (running?.controller) running.controller.abort("cancel");
          else { cleanParts(dir(), cmd.repo, cmd.file); pulls.delete(keyOf(cmd.repo, cmd.file)); tellFile(cmd.repo, cmd.file, { state: "idle" }); tellInstalled(); }
          return true;
        }
        case "local.remove":
          if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
          pulls.get(keyOf(cmd.repo, cmd.file))?.controller?.abort("cancel");
          removeModel(dir(), cmd.repo, cmd.file);
          cleanParts(dir(), cmd.repo, cmd.file);
          pulls.delete(keyOf(cmd.repo, cmd.file));
          tellFile(cmd.repo, cmd.file, { state: "idle" });
          tellInstalled();
          return true;
        default:
          return false;
      }
    },
  };
}
