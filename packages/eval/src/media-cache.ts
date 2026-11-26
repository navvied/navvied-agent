import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHub } from "../../cli/src/commands/hub.ts";
import { configPath, loadConfig } from "../../cli/src/config.ts";
import { processIO } from "../../cli/src/io.ts";

/**
 * The engines of the media tools for a run with a real model, installed once into a folder of their own outside the repository and kept for the next runs. They are
 * installed through the program's own path (`tool.setup` on the hub: size shown, approval given, hashes checked, files taken apart, configuration written), so what the
 * lane uses is what a person gets. Only the processor is used: no graphics card is touched. Nothing of the person's own configuration is read or written.
 */
export const MEDIA_TOOLS = ["speech-to-text", "text-to-speech", "image", "vision"] as const;
const KEYS = ["stt", "tts", "image", "vision"] as const;

export const mediaDir = (env: Record<string, string | undefined> = process.env): string => env.NAVVIED_BENCH_MEDIA || join(env.HOME || homedir(), ".cache", "navvied-bench", "media");

/** The environment the setup runs in, and whose configuration file the engines are written to. */
const envOf = (dir: string): Record<string, string | undefined> => ({ ...process.env, HOME: dir, XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), NAVVIED_GUEST_MODELS: "0", CUDA_VISIBLE_DEVICES: "" });

/** What is installed in the folder, as the `media` part of a configuration, with the system's own ffmpeg and pdftoppm where there are such; nothing while an engine is missing. */
export function installedMedia(dir: string, which: (program: string) => string | null = (p) => Bun.which(p)): Record<string, unknown> | undefined {
  const env = envOf(dir);
  const file = configPath(env);
  if (!existsSync(file)) return undefined;
  const f = loadConfig(file, env);
  const media = f.ok ? (f.value?.media as Record<string, unknown> | undefined) : undefined;
  if (!media || KEYS.some((k) => !media[k])) return undefined;
  const ffmpeg = which("ffmpeg"), pdftoppm = which("pdftoppm");
  return { ...media, ...(ffmpeg && !media.ffmpeg ? { ffmpeg } : {}), ...(pdftoppm && !media.pdftoppm ? { pdftoppm } : {}) };
}

/**
 * The engines, installed when they are not there yet (about 3 GB the first time, then nothing). Says what it does through `say`. An engine that cannot be installed on this
 * computer is an error, never a reason to measure without it.
 */
export async function prepareMedia(dir: string, say: (line: string) => void = () => undefined): Promise<Record<string, unknown> | string> {
  const now = installedMedia(dir);
  if (now) return now;
  mkdirSync(join(dir, "config", "navvied"), { recursive: true });
  const env = envOf(dir);
  const file = configPath(env);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ default: "m", models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "none", window: 1000 } } }), { mode: 0o600 });
  process.env.CUDA_VISIBLE_DEVICES = "";
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, { ...processIO(), env }, { watch: false, import: false });
  const got: { ev: string; id?: string; state?: string; error?: string; file?: string }[] = [];
  hub.attach({ send: (line: unknown) => { const e = JSON.parse(String(line)); got.push(e); if (e.ev === "tool.setup" && e.state && e.state !== "downloading") say(`${e.id} ${e.state}${e.error ? `: ${e.error}` : ""}`); } } as never, 0);
  const last = (id: string) => got.filter((e) => e.ev === "tool.setup" && e.id === id).at(-1);
  const until = async (id: string, states: string[], ms: number): Promise<void> => { const end = Date.now() + ms; while (!states.includes(last(id)?.state ?? "")) { if (Date.now() > end) throw new Error(`${id}: timed out`); await new Promise((r) => setTimeout(r, 200)); } };
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  try {
    for (const id of MEDIA_TOOLS) {
      if (last(id)?.state === "done") continue;
      send({ cmd: "tool.setup", id });
      await until(id, ["ask", "unavailable", "failed", "done"], 60_000);
      if (last(id)!.state === "ask") { send({ cmd: "tool.setup.approve", id }); await until(id, ["unavailable", "failed", "done"], 40 * 60_000); }
      if (last(id)!.state !== "done") return `${id} could not be installed: ${last(id)!.error ?? last(id)!.state}`;
    }
  } catch (e) { return e instanceof Error ? e.message : String(e); } finally { await hub.stop(); }
  return installedMedia(dir) ?? "the engines were installed but the configuration does not list them";
}
