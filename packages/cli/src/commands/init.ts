import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Options } from "../args.ts";
import { mark, wordmark } from "../banner.ts";
import { paint } from "../render.ts";
import { DEFAULT_SERVER } from "../account.ts";
import { accountPath, configPath, hostedModelsPath, loadConfig, type ConfigFile, type ModelEntry } from "../config.ts";
import { login } from "../login-ui.ts";
import type { Choice, IO, Watch, WorkContext } from "../io.ts";
import { PRESETS, authHeaders, localName, type LocalServer, type Screen } from "../presets.ts";
import { EXIT } from "./run.ts";

const LOCAL_PORTS = [11434, 1234, 8080, 8000];

export type { LocalServer } from "../presets.ts";

/** Look for model servers on this machine that speak the chat-completions API. */
export async function findLocalServers(fetchFn: typeof fetch): Promise<LocalServer[]> {
  const probes = LOCAL_PORTS.map(async (port): Promise<LocalServer | undefined> => {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
      const res = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(700) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      return { name: localName(baseUrl), baseUrl, models, ...(port === 11434 ? { ollama: true } : {}) };
    } catch { return undefined; }
  });
  return (await Promise.all(probes)).filter((s): s is LocalServer => s !== undefined);
}

export async function reachable(entry: ModelEntry, env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<boolean> {
  if (!entry.baseUrl) return false;
  const key = (entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined) ?? entry.apiKey;
  const root = entry.baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetchFn(entry.api === "ollama" ? `${root}/api/tags` : `${root}/models`, { headers: authHeaders(entry.api, key), signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

/** Raised when "back" is chosen on a question, so the list of services comes back. */
class Back extends Error {}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";

export type NextLine = () => Promise<string | undefined>;

export async function initCommand(options: Options, io: IO): Promise<number> {
  if (!io.interactive) { io.stderr.write("error: navvied init needs a terminal; create the configuration file by hand instead (see docs/CLI.md)\n"); return EXIT.usage; }
  const input = io.lines()[Symbol.asyncIterator]();
  return setupModel(options, io, async () => { const n = await input.next(); return n.done ? undefined : n.value; }, true);
}

/** Walk through connecting a model and save it. `next` supplies the typed answers; `logo` adds the welcome artwork. */
export async function setupModel(options: Options, io: IO, next: NextLine, logo: boolean): Promise<number> {
  const path = configPath(io.env, options.config);
  const existing = loadConfig(path);
  if (!existing.ok) { io.stderr.write(`error: ${existing.error}\nFix or remove that file, then run navvied init again.\n`); return EXIT.usage; }
  const config: ConfigFile = existing.value ?? { models: {} };

  const inApp = !logo;
  const heading = [
    `${mark(io.color)}  ${paint(io.color, "cyan", paint(io.color, "bold", "navvied"))}`,
    "",
    paint(io.color, "cyan", paint(io.color, "bold", "Connect a model")),
    paint(io.color, "dim", "Pick with ↑ ↓ and Enter. Nothing to type except a key you paste."),
  ];
  let notice: string[] = [];
  const frame = (): { heading: string[]; notice: string[] } => { const f = { heading: inApp ? heading : [], notice }; notice = []; return f; };

  const askOrBack = async (question: string, fallback = "", body?: string[]): Promise<string | "back"> => {
    if (inApp && io.text) {
      const v = await io.text(question, fallback, { ...frame(), ...(body ? { body } : {}) });
      if (v === undefined) throw new Error("input closed");
      return v === "back" ? "back" : v || fallback;
    }
    io.prompt(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    const line = await next();
    if (line === undefined) throw new Error("input closed");
    return line.trim() || fallback;
  };
  const ask = async (question: string, fallback = ""): Promise<string> => {
    const v = await askOrBack(question, fallback);
    if (v === "back") throw new Back();
    return v;
  };
  const pick = async (title: string, items: Choice[], initial = 0, watch?: Watch, body?: string[]): Promise<number | "back"> => {
    if (io.choose) {
      const i = await io.choose(title, items, initial, { ...frame(), ...(body ? { body } : {}) }, watch);
      if (i === undefined) throw new Error("input closed");
      return i;
    }
    io.stderr.write(`${title}\n\n${items.map((it, i) => `  ${i + 1}  ${it.label}${it.hint ? `\n     ${it.hint}` : ""}`).join("\n")}\n\n`);
    const n = Number(await ask("Choose", String(initial + 1)));
    return Number.isInteger(n) && n >= 1 && n <= items.length ? n - 1 : initial;
  };
  const secret = async (prompt: string): Promise<string | "back"> => {
    if (io.secret) {
      const v = await io.secret(prompt, frame());
      if (v === undefined) throw new Error("input closed");
      return v;
    }
    return ask(prompt);
  };
  const work = async <T>(title: string, parts: { body?: string[]; status?: string }, task: (context: WorkContext) => Promise<T>): Promise<T | "back"> => {
    if (!io.work) return task({ log: () => {}, signal: new AbortController().signal });
    const outcome = await io.work(title, { ...frame(), ...parts }, task);
    if (outcome === undefined) throw new Error("input closed");
    return outcome;
  };
  const say = (text: string): void => {
    if (inApp && io.choose) notice = text.split("\n").filter((l) => l.trim() !== "");
    else io.stderr.write(`${text}\n`);
  };

  try {
    const c = io.color;
    if (!inApp) {
      const intro = [paint(c, "bold", "Let's connect a model."), paint(c, "dim", "Pick with ↑ ↓ and Enter. Nothing to type except a key you paste.")];
      io.stderr.write(`\n${wordmark(c).map((l) => `  ${l}`).join("\n")}\n\n  ${mark(c)}  ${paint(c, "dim", "Welcome to navvied")}\n\n${intro.map((l) => `  ${l}`).join("\n")}\n\n`);
    }
    const local = await findLocalServers(io.fetch);
    const screen: Screen = { io, sys: io.system, pick, secret, ask, askOrBack, say, work, local };

    // What the person is offered, in the order that suits them: a model already running on this computer first, then the models we
    // host (nothing to install), then the rest. The top row is always the one that is chosen to begin with.
    const hostedOffered = Boolean(io.choose && io.text && io.secret && io.work);
    type Entry = { row: Choice; preset?: (typeof PRESETS)[number] };
    const presetEntries: Entry[] = PRESETS.map((p) => ({ row: { label: p.label, hint: p.hint }, preset: p }));
    const hostedEntry: Entry = { row: { label: "The models we host", hint: "Sign in or make a free account. Nothing to install; your files stay on this computer." } };
    const localAt = local.length ? presetEntries.findIndex((e) => e.preset?.label.startsWith("A model on")) : -1;
    // Without menus (a plain list with numbers) nothing moves, so the numbers people know stay the same.
    const ordered: Entry[] = !hostedOffered ? presetEntries
      : localAt >= 0 ? [presetEntries[localAt]!, hostedEntry, ...presetEntries.filter((_, i) => i !== localAt)]
      : [hostedEntry, ...presetEntries];
    const first = hostedOffered ? 0 : Math.max(0, localAt);
    let chosen: { name: string; entry: ModelEntry } | undefined;
    while (!chosen) {
      const at = await pick("Which one do you use?", ordered.map((e) => e.row), first);
      if (at === "back") continue;
      const picked = ordered[at]!;
      if (!picked.preset) {
        const outcome = await login(io, { account: accountPath(io.env, options.config), models: hostedModelsPath(io.env) }, undefined, io.env.NAVVIED_SERVER ?? DEFAULT_SERVER);
        if (outcome.kind !== "signed-in") continue;
        io.stderr.write(`${paint(c, "green", "✓")} Signed in as ${paint(c, "bold", outcome.email)}. ${inApp ? "Ask anything below." : `You are ready. Try:  navvied run "say hello"   or just   navvied`}\n`);
        return EXIT.ok;
      }
      try {
        const result = await picked.preset.configure(screen);
        if (result !== "back") chosen = result;
      } catch (e) { if (!(e instanceof Back)) throw e; }
    }
    const { name, entry } = chosen;

    const makeDefault = !config.default || (config.default !== name && (await pick(`Make "${name}" your default model?`, [{ label: "Yes" }, { label: "No, keep the current one" }])) === 0);
    config.models[name] = entry;
    if (makeDefault) config.default = name;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    chmodSync(path, 0o600);
    const answered = entry.baseUrl ? await reachable(entry, io.env, io.fetch) : true;
    if (inApp) {
      io.stderr.write(`${paint(c, "green", "✓")} Connected to ${paint(c, "bold", entry.model ?? name)}. Ask anything below.\n`);
      if (!answered) io.stderr.write(`${paint(c, "yellow", "●")} It did not answer just now. Check the address and key, or run navvied doctor.\n`);
      return EXIT.ok;
    }
    io.stderr.write(`\n${paint(c, "green", "✓")} Saved to ${path}\n`);
    io.stderr.write(answered ? `${paint(c, "green", "✓")} the model server answered\n` : "! could not reach it just now; check the address and key, or run navvied doctor\n");
    io.stderr.write(`\n${paint(c, "bold", "You are ready.")} Try:  navvied run "say hello"   or just   navvied\n\n`);
    return EXIT.ok;
  } catch (e) {
    io.stderr.write(`\n${e instanceof Error && e.message === "input closed" ? "setup cancelled" : `error: ${e instanceof Error ? e.message : String(e)}`}\n`);
    return EXIT.usage;
  }
}
