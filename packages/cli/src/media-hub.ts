import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, PermMode } from "@navvied/protocol";
import { localDir, saveMedia } from "./config.ts";
import type { IO } from "./io.ts";
import { readMachine, realProbe, type Machine, type Probe } from "./machine.ts";
import type { MediaConfig } from "./media-config.ts";
import { fetchPieces, isFetched, patchFor, setupFor, toolFolder, type FetchState, type MediaToolId } from "./media-install.ts";
import { VISION_FILES, type Piece, type Setup } from "./media-pins.ts";
import { RUNTIME, RUNTIME_DRIVERS } from "./presets.ts";
import { stepsOf, type SetupAt, type SetupItem } from "./setup-steps.ts";
import { installRuntime, installedBinary, pickAsset, type RuntimeAsset } from "./runtime.ts";

export interface MediaSetupDeps {
  io: IO;
  /** A cloud session installs nothing. */
  inCloud(): boolean;
  configFile(): string;
  probe?(): Probe;
  /** Tells every window. */
  tell(e: EngineEvent): void;
  /** What the tools may use changed: the list of tools is made again. */
  changed(): void;
  /** What is fetched for a tool, when it is not the pinned table (a test gives its own). */
  setups?: Partial<Record<MediaToolId, Setup>>;
  /** Trying a program once after it is in place (a test gives its own). */
  tryProgram?: (argv: readonly string[]) => Promise<boolean>;
}

type Say = Extract<EngineEvent, { ev: "tool.setup" }>;

/** The rows of the Tools list that stand for the same files: Video Analysis looks at frames with the model of Vision. */
const KEY: Record<string, MediaToolId | "vision"> = { "speech-to-text": "speech-to-text", "text-to-speech": "text-to-speech", image: "image", vision: "vision", "video-analysis": "vision" };

const NOT_HERE = "This is not available for this computer yet.";
const NO_VIDEO = "Video cannot be made on this computer. It needs a service.";
const NO_FFMPEG = "Video analysis needs ffmpeg. Install it first.";

interface Job { key: string; ids: Set<string>; ctrl: AbortController; approve?: () => void; last?: Say; /** What is fetched, in order, and how far it got: the steps of every event are made from these. */ items: SetupItem[]; progress: { file?: string; bytes: number } }

/**
 * The setup of the tools that run on this computer: what is fetched is said and asked about first (in every mode but bypass), then fetched with its progress told, proven by its
 * pinned hash, taken apart, tried once, and written into `media` in config.json so the tool works with nothing else to configure.
 */
export function mediaSetups(d: MediaSetupDeps): { ids: readonly string[]; start(id: string, mode?: PermMode): void; approve(id: string): void; cancel(id: string): void } {
  const dir = (): string => localDir(d.io.env);
  const probe = (): Probe => d.probe?.() ?? realProbe(d.io.system);
  const jobs = new Map<string, Job>();
  const free = (): number | undefined => { const disk = probe().disk(dir()); return disk ? disk.freeMb * 1048576 : undefined; };
  const mb = (n: number): number => Math.ceil(n / 1048576);

  const where = (job: Job, e: Omit<Say, "ev" | "id">): SetupAt | undefined => {
    if (e.state === "unavailable") return undefined;
    if (e.state === "ask") return { at: "ask" };
    if (e.state === "done") return { at: "done" };
    if (e.state === "failed") return { at: "failed", ...job.progress };
    if (e.state === "idle") return { at: "paused", ...job.progress };
    job.progress = { ...(e.file ? { file: e.file } : {}), bytes: e.bytes ?? 0 };
    return { at: "work", ...job.progress };
  };
  const say = (job: Job, e: Omit<Say, "ev" | "id">): void => {
    const at = where(job, e);
    job.last = { ev: "tool.setup", id: "", ...e, ...(at && job.items.length ? stepsOf(job.items, at) : {}) };
    for (const id of job.ids) d.tell({ ...job.last, id });
  };
  const stateOf = (job: Job, s: FetchState, offset = 0, extra = 0): void => {
    if (s.state === "done") return;
    if (s.state === "failed") say(job, { state: "failed", error: s.error });
    else if (s.state === "idle") say(job, { state: "idle" });
    else say(job, { state: s.state, file: s.file, bytes: s.bytes + offset, total: s.total + extra });
  };

  const run = async (job: Job, mode: PermMode | undefined): Promise<void> => {
    const key = job.key;
    mkdirSync(join(dir(), "media"), { recursive: true, mode: 0o700 });
    let pieces: readonly Piece[], folder = toolFolder(dir(), key), runtime: RuntimeAsset | undefined, setupProgram: { program: string; args: readonly string[] } | undefined, patch: () => MediaConfig;

    if (key === "vision") {
      const m: Machine = await readMachine(probe(), dir());
      runtime = pickAsset(RUNTIME, m, RUNTIME_DRIVERS, "cpu");
      if (!runtime) { say(job, { state: "unavailable", error: NOT_HERE }); return; }
      pieces = VISION_FILES;
      patch = () => ({ vision: { local: { server: installedBinary(dir(), RUNTIME, runtime!)!, model: join(folder, VISION_FILES[0]!.file), mmproj: join(folder, VISION_FILES[1]!.file) } } });
    } else {
      const setup = d.setups?.[key as MediaToolId] ?? setupFor(key as MediaToolId, process.platform, process.arch);
      if (!setup) { say(job, { state: "unavailable", error: NOT_HERE }); return; }
      pieces = setup.pieces;
      setupProgram = { program: join(folder, setup.program), args: setup.check };
      patch = () => patchFor(key as MediaToolId, folder, setup);
    }

    const runtimeLeft = runtime && !installedBinary(dir(), RUNTIME, runtime) ? runtime : undefined;
    const left = pieces.filter((p) => !isFetched(folder, [p]));
    const files = [...(runtimeLeft ? [{ name: runtimeLeft.file, sizeMb: mb(runtimeLeft.size) }] : []), ...left.map((p) => ({ name: p.file, sizeMb: mb(p.size) }))];
    const bytes = (runtimeLeft?.size ?? 0) + left.reduce((n, p) => n + p.size, 0);
    job.items = [...(runtimeLeft ? [{ name: runtimeLeft.file, size: runtimeLeft.size }] : []), ...left.map((p) => ({ name: p.file, size: p.size }))];

    if (files.length && mode !== "bypass") {
      say(job, { state: "ask", files, totalMb: mb(bytes) });
      await new Promise<void>((resolve) => { job.approve = resolve; job.ctrl.signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      if (job.ctrl.signal.aborted) { say(job, { state: "idle" }); return; }
    }

    const fail = (error: string): void => { say(job, { state: "failed", error }); };
    let offset = 0;
    if (runtimeLeft) {
      const got = await installRuntime({
        pin: RUNTIME, asset: runtimeLeft, local: dir(), fetchFn: d.io.fetch, platform: process.platform, signal: job.ctrl.signal,
        run: (argv, timeoutMs) => d.io.system.run(argv, { timeoutMs }),
        freeBytes: free,
        onState: (s) => {
          if (s.state === "installing" || s.state === "verifying") say(job, { state: s.state, file: s.file, bytes: s.bytes, total: bytes });
        },
      });
      if (!got.ok) { if (got.error === "paused" || got.error === "cancelled") say(job, { state: "idle" }); else fail(got.error); return; }
      offset = runtimeLeft.size;
    }
    const got = await fetchPieces({
      pieces, dir: folder, fetchFn: d.io.fetch, freeBytes: free, signal: job.ctrl.signal,
      onState: (s) => { stateOf(job, s, offset, offset); },
      ...(d.tryProgram ? { tryProgram: d.tryProgram } : {}),
      ...(setupProgram ? { check: setupProgram } : {}),
    });
    if (!got.ok) return;
    const saved = saveMedia(d.configFile(), patch());
    if (!saved.ok) { fail(`The setup was done, but it could not be written to the configuration: ${saved.error}`); return; }
    say(job, { state: "done" });
    d.changed();
  };

  return {
    ids: Object.keys(KEY).concat("video-generation"),
    start(id, mode) {
      if (id === "video-generation") { d.tell({ ev: "tool.setup", id, state: "unavailable", error: NO_VIDEO }); return; }
      if (d.inCloud()) { d.tell({ ev: "tool.setup", id, state: "unavailable", error: NOT_HERE }); return; }
      if (id === "video-analysis" && !d.io.system.which("ffmpeg")) { d.tell({ ev: "tool.setup", id, state: "unavailable", error: NO_FFMPEG }); return; }
      const key = KEY[id];
      if (!key) { d.tell({ ev: "error", msg: "That tool has nothing to set up." }); return; }
      const running = jobs.get(key);
      if (running) { running.ids.add(id); if (running.last) d.tell({ ...running.last, id }); return; }
      const job: Job = { key, ids: new Set([id]), ctrl: new AbortController(), items: [], progress: { bytes: 0 } };
      jobs.set(key, job);
      void run(job, mode).catch((e: unknown) => { say(job, { state: "failed", error: e instanceof Error ? e.message : "The setup stopped." }); }).finally(() => { jobs.delete(key); });
    },
    approve(id) { jobs.get(KEY[id] ?? "")?.approve?.(); },
    cancel(id) { jobs.get(KEY[id] ?? "")?.ctrl.abort("pause"); },
  };
}
