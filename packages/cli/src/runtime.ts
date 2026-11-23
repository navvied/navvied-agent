import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { download } from "./download.ts";
import type { Gpu, Machine } from "./machine.ts";

export type Backend = "cpu" | "vulkan" | "cuda12" | "cuda13" | "metal";
export interface PinnedFile { file: string; sha256: string; size: number }
export interface RuntimeAsset extends PinnedFile { os: "linux" | "macos" | "windows"; arch: "x64" | "arm64"; backend: Backend; with?: PinnedFile }
export interface RuntimePin { tag: string; commit: string; base: string; assets: readonly RuntimeAsset[] }
export type DriverRules = Record<"cuda12" | "cuda13", { linux: string; windows: string }>;

const osOf = (m: Machine): RuntimeAsset["os"] | undefined => (m.os === "linux" || m.os === "wsl" ? "linux" : m.os === "macos" ? "macos" : m.os === "windows" ? "windows" : undefined);

/** `550.54.14` is not older than `550.54` and is older than `551`: compared part by part, as numbers. */
export function atLeast(version: string, wanted: string): boolean {
  const a = version.split(".").map(Number), b = wanted.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (Number.isNaN(x)) return false; if (x !== y) return x > y; }
  return true;
}

/**
 * The builds to try, best first, for this computer: the card's own toolkit when its driver is new enough, else the one every card with a Vulkan driver runs, and the processor
 * last. A card whose kind or driver could not be read gets nothing it cannot be sure of.
 */
export function backendsFor(m: Machine, rules: DriverRules): Backend[] {
  const os = osOf(m);
  if (!os) return [];
  if (os === "macos") return m.arch === "arm64" ? ["metal"] : ["cpu"];
  const discrete = m.gpus.filter((g) => g.kind === "discrete");
  const out: Backend[] = [];
  const nvidia = discrete.find((g: Gpu) => g.vendor === "nvidia" && g.driver);
  if (nvidia && m.arch === "x64") {
    if (atLeast(nvidia.driver!, rules.cuda13[os])) out.push("cuda13");
    if (atLeast(nvidia.driver!, rules.cuda12[os])) out.push("cuda12");
  }
  if (discrete.length) out.push("vulkan");
  out.push("cpu");
  return out;
}

/** The files of the build to use: the first of the backends for which the release has a build for this system. */
export function pickAsset(pin: RuntimePin, m: Machine, rules: DriverRules, forced?: Backend): RuntimeAsset | undefined {
  const os = osOf(m);
  if (!os || (m.arch !== "x64" && m.arch !== "arm64")) return undefined;
  // A person may name the build (`NAVVIED_LOCAL_BACKEND`): to keep a card out of it, or to try another.
  for (const b of forced ? [forced] : backendsFor(m, rules)) { const a = pin.assets.find((x) => x.os === os && x.arch === m.arch && x.backend === b); if (a) return a; }
  return undefined;
}

export type RuntimeState =
  | { state: "none" }
  | { state: "installing" | "verifying"; file: string; bytes: number; total: number }
  | { state: "failed"; error: string }
  | { state: "ready"; tag: string; backend: Backend; binary: string };

interface Installed { tag: string; commit: string; backend: Backend; binary: string; files: { file: string; sha256: string }[] }

const folderOf = (local: string, pin: RuntimePin, a: RuntimeAsset): string => join(local, "runtime", pin.tag, `${a.os}-${a.arch}-${a.backend}`);

/** The program of an install that was finished and has not changed since (a folder that was taken apart is not "ready"). */
export function installedBinary(local: string, pin: RuntimePin, a: RuntimeAsset): string | undefined {
  const dir = folderOf(local, pin, a);
  try {
    const rec = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")) as Installed;
    const binary = join(dir, rec.binary);
    return rec.tag === pin.tag && rec.backend === a.backend && rec.files[0]?.sha256 === a.sha256 && existsSync(binary) ? binary : undefined;
  } catch { return undefined; }
}

function findServer(dir: string, name: string, depth = 4): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name === name) return join(dir, e.name);
    if (e.isDirectory() && depth > 0) { const f = findServer(join(dir, e.name), name, depth - 1); if (f) return f; }
  }
  return undefined;
}

/** Nothing the archive made may be outside the folder it was unpacked into (the archive is pinned by its hash, and this is checked again). */
function insideOnly(dir: string): boolean {
  const root = realpathSync(dir);
  const walk = (d: string): boolean => readdirSync(d, { withFileTypes: true }).every((e) => {
    const p = join(d, e.name);
    const real = realpathSync(p);
    return (real === root || real.startsWith(root + sep)) && (!e.isDirectory() || e.isSymbolicLink() || walk(p));
  });
  return walk(dir);
}

export interface InstallInput {
  pin: RuntimePin;
  asset: RuntimeAsset;
  /** The folder models and the runtime are kept in. */
  local: string;
  fetchFn: typeof fetch;
  /** Runs a program (the unpacking tool, then the program itself once, for its version). */
  run: (argv: string[], timeoutMs: number) => Promise<{ code: number; output: string }>;
  freeBytes: () => number | undefined;
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  onState: (s: RuntimeState) => void;
}

/**
 * Fetches the build, proves it is the one that was published, unpacks it, and runs it once for its version. The order is the point: a file whose hash is not the pinned one is
 * deleted and nothing is run; the unpacking tool runs on a file that passed; the program runs only after both. Pausing leaves what was fetched for a later start.
 */
export async function installRuntime(i: InstallInput): Promise<{ ok: true; binary: string } | { ok: false; error: string }> {
  const dir = folderOf(i.local, i.pin, i.asset);
  const staging = join(i.local, "runtime", i.pin.tag, "downloads");
  const files = [i.asset, ...(i.asset.with ? [i.asset.with] : [])];
  const fail = (error: string): { ok: false; error: string } => { i.onState({ state: "failed", error }); return { ok: false, error }; };
  const total = files.reduce((n, f) => n + f.size, 0);
  let before = 0;
  for (const f of files) {
    const dest = join(staging, f.file);
    const got = await download(i.fetchFn, {
      url: `${i.pin.base}/${i.pin.tag}/${f.file}`, dest, sha256: f.sha256, size: f.size,
      ...(i.signal ? { signal: i.signal } : {}),
      // What is fetched, unpacked beside it, and a little left over.
      freeBytes: () => { const free = i.freeBytes(); return free === undefined ? undefined : free - f.size * 2; },
      onProgress: (bytes) => i.onState({ state: "installing", file: f.file, bytes: before + bytes, total }),
    });
    if (!got.ok) {
      if (got.why === "wrong") return fail(`${f.file} is not the file that was published (its hash is different): it was deleted and nothing of it was run.`);
      if (got.why === "nodisk") return fail(`There is not enough room on the disk: ${Math.ceil(got.needBytes / 1048576)} MB are needed and ${Math.floor(got.freeBytes / 1048576)} MB are free.`);
      if (got.why === "paused") return fail("paused");
      if (got.why === "cancelled") return fail("cancelled");
      return fail("message" in got ? got.message : "The download did not finish.");
    }
    before += f.size;
  }
  i.onState({ state: "verifying", file: i.asset.file, bytes: total, total });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const un = await i.run(["tar", "-xf", join(staging, f.file), "-C", dir], 600_000);
    if (un.code !== 0) { rmSync(dir, { recursive: true, force: true }); return fail("The downloaded file could not be unpacked."); }
  }
  for (const f of files) rmSync(join(staging, f.file), { force: true });
  if (!insideOnly(dir)) { rmSync(dir, { recursive: true, force: true }); return fail("The unpacked files were not all inside the folder they belong in: they were deleted."); }
  const binary = findServer(dir, i.platform === "win32" ? "llama-server.exe" : "llama-server");
  if (!binary) { rmSync(dir, { recursive: true, force: true }); return fail("The program was not in what was unpacked."); }
  if (i.platform !== "win32") chmodSync(binary, 0o755);
  const version = await i.run([binary, "--version"], 20_000);
  if (version.code !== 0) { rmSync(dir, { recursive: true, force: true }); return fail("The program did not start: it was deleted."); }
  const rec: Installed = { tag: i.pin.tag, commit: i.pin.commit, backend: i.asset.backend, binary: relative(dir, binary), files: files.map((f) => ({ file: f.file, sha256: f.sha256 })) };
  writeFileSync(join(dir, "installed.json"), JSON.stringify(rec, null, 2));
  i.onState({ state: "ready", tag: i.pin.tag, backend: i.asset.backend, binary });
  return { ok: true, binary };
}

/** What is there now, for the build this computer should use. */
export function runtimeState(local: string, pin: RuntimePin, m: Machine, rules: DriverRules, forced?: Backend): RuntimeState & { asset?: RuntimeAsset } {
  const asset = pickAsset(pin, m, rules, forced);
  if (!asset) return { state: "failed", error: "There is no build of the runtime for this computer." };
  const binary = installedBinary(local, pin, asset);
  return binary ? { state: "ready", tag: pin.tag, backend: asset.backend, binary, asset } : { state: "none", asset };
}

