import { bunSpawn } from "@navvied/engine";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { VERSION } from "../help.ts";
import type { IO } from "../io.ts";
import { paint } from "../render.ts";
import { EXIT } from "./run.ts";

export const DEFAULT_RELEASE_URL = "https://github.com/navvied/navvied-agent/releases/latest/download";

export interface Machine { os: "darwin" | "linux" | "windows"; arch: "arm64" | "x64"; variant: "" | "musl" | "baseline" }

export interface UpdateTarget extends Machine {
  base: string;
  /** The installed program to replace. */
  exe: string;
  fetch: typeof fetch;
}

/** The release file for a machine, named the same way the installers name it. */
export const assetName = (m: Machine): string => `navvied-${m.os}-${m.arch}${m.variant ? `-${m.variant}` : ""}${m.os === "windows" ? ".exe" : ""}`;

const listDir = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

/** What this machine needs: Windows, macOS or Linux; Apple/ARM or x64; musl libc; x64 without AVX2 (the baseline build). */
export function detectMachine(platform: NodeJS.Platform = process.platform, arch: string = process.arch, cpuinfo?: string, libs?: string[]): Machine {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  if (os !== "linux") return { os, arch: cpu, variant: "" };
  if ((libs ?? [...listDir("/lib"), ...listDir("/usr/lib")]).some((n) => n.startsWith("ld-musl-"))) return { os, arch: cpu, variant: "musl" };
  const flags = cpuinfo ?? (existsSync("/proc/cpuinfo") ? readFileSync("/proc/cpuinfo", "utf8") : "");
  return { os, arch: cpu, variant: cpu === "x64" && flags !== "" && !/\bavx2\b/.test(flags) ? "baseline" : "" };
}

const sha256 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const releaseBase = (env: Record<string, string | undefined>, version?: string): string => {
  const base = env.NAVVIED_RELEASE_URL ?? DEFAULT_RELEASE_URL;
  if (!version) return base;
  return base.endsWith("/releases/latest/download") ? `${base.slice(0, -"/latest/download".length)}/download/${version}` : `${base}/${version}`;
};

export const isInstalledProgram = (exe: string): boolean => !["bun", "bun.exe", "node", "node.exe"].includes(basename(exe));

export type UpdateProgress =
  | { step: "checking" }
  | { step: "downloading"; received: number; total: number }
  | { step: "verifying" }
  | { step: "installing" };

/** Reads a response body while reporting how much has arrived. */
async function download(res: Response, report: (received: number, total: number) => void): Promise<Uint8Array> {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report(received, total);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return bytes;
}

/** Replace the installed program with the release's, after checking its checksum. */
export async function updateProgram(t: UpdateTarget, progress: (p: UpdateProgress) => void = () => {}): Promise<"current" | "updated"> {
  const asset = assetName(t);
  const get = async (name: string): Promise<Response> => {
    const res = await t.fetch(`${t.base}/${name}`);
    if (!res.ok) throw new Error(`could not download ${t.base}/${name} (${res.status})`);
    return res;
  };
  progress({ step: "checking" });
  const sums = await (await get("SHA256SUMS")).text();
  const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
  if (!expected) throw new Error(`no checksum is listed for ${asset}`);
  if (sha256(readFileSync(t.exe)) === expected) return "current";

  const bytes = await download(await get(asset), (received, total) => progress({ step: "downloading", received, total }));
  progress({ step: "verifying" });
  if (sha256(bytes) !== expected) throw new Error(`checksum mismatch for ${asset}; the program was not changed`);
  progress({ step: "installing" });
  const staged = `${t.exe}.new`;
  writeFileSync(staged, bytes);
  chmodSync(staged, 0o755);
  if (t.os === "windows") {
    // A running .exe cannot be overwritten or removed, but it can be renamed. The copy left by the last update may still be running
    // (another window): it is cleared when it can be, and the one being replaced goes to a name of its own when it cannot.
    const old = `${t.exe}.old`;
    for (const name of readdirSync(dirname(t.exe))) if (name.startsWith(`${basename(t.exe)}.old.`)) try { rmSync(join(dirname(t.exe), name), { force: true }); } catch { /* still running */ }
    try { rmSync(old, { force: true }); } catch { /* still running: left where it is */ }
    renameSync(t.exe, existsSync(old) ? `${old}.${Date.now()}` : old);
  }
  renameSync(staged, t.exe);
  return "updated";
}

const megabytes = (n: number): string => `${(n / 1_048_576).toFixed(n >= 10_485_760 ? 0 : 1)} MB`;

/** `████████░░░░  52%   49 of 95 MB   12 MB/s`, sized to the terminal. */
export function progressLine(received: number, total: number, seconds: number, width: number, color: (text: string) => string): string {
  const rate = seconds > 0.3 ? `   ${megabytes(received / seconds)}/s` : "";
  if (total <= 0) return `  ${megabytes(received)} downloaded${rate}`;
  const share = Math.min(1, received / total);
  const bar = Math.max(10, Math.min(40, width - 44));
  const filled = Math.round(share * bar);
  return `  ${color("█".repeat(filled))}${"░".repeat(bar - filled)}  ${String(Math.round(share * 100)).padStart(3)}%   ${megabytes(received)} of ${megabytes(total)}${rate}`;
}

async function versionOf(exe: string): Promise<string | undefined> {
  try {
    const p = bunSpawn([exe, "--version"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(p.stdout).text();
    return /\d+\.\d+\.\d+/.exec(text)?.[0];
  } catch { return undefined; }
}

export async function updateCommand(version: string | undefined, io: IO, exe: string = process.execPath, machine: Machine = detectMachine()): Promise<number> {
  const c = io.color;
  const say = (text: string): void => { io.stderr.write(`${text}\n`); };
  const accent = (t: string): string => paint(c, "cyan", t);
  if (io.env.NAVVIED_NO_UPDATE) { say("Updates are turned off here: whatever installed this program updates it."); return EXIT.usage; }
  if (!isInstalledProgram(exe)) { say("error: update works on the installed program. You are running from source: git pull, then build again."); return EXIT.usage; }
  const before = VERSION;
  let started = 0, drawn = false, last = 0;
  const live = io.interactive;
  try {
    say("Checking for a newer version…");
    const result = await updateProgram({ ...machine, base: releaseBase(io.env, version), exe, fetch: io.fetch }, (p) => {
      if (p.step === "downloading") {
        if (!started) { started = Date.now(); say(`A newer version is available. Downloading${p.total ? ` (${megabytes(p.total)})` : ""}…`); }
        const now = Date.now();
        if (live && (now - last > 90 || p.received === p.total)) {
          last = now;
          io.stderr.write(`\r\u001b[2K${progressLine(p.received, p.total, (now - started) / 1000, process.stderr.columns ?? 80, accent)}`);
          drawn = true;
        }
      } else if (drawn) { io.stderr.write("\n"); drawn = false; }
      if (p.step === "verifying") say(`${paint(c, "green", "✓")} Downloaded. Checking that the file is genuine…`);
      if (p.step === "installing") say(`${paint(c, "green", "✓")} Verified. Installing…`);
    });
    if (drawn) io.stderr.write("\n");
    if (result === "current") { say(`${paint(c, "green", "✓")} You already have the latest version (${before}).`); return EXIT.ok; }
    const after = await versionOf(exe);
    say(`${paint(c, "green", "✓")} Updated${after ? ` from ${before} to ${after}` : ""}. It starts the next time you run ${accent(paint(c, "bold", "navvied"))}.`);
    return EXIT.ok;
  } catch (e) {
    if (drawn) io.stderr.write("\n");
    say(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.failed;
  }
}
