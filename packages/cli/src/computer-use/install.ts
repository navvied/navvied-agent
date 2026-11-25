import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { download, type DownloadResult } from "../download.ts";
import type { Pin, PinnedAsset, Signer, Target } from "./pin.ts";

export interface Ran { code: number; out: string; err: string }
export type Run = (cmd: string, args: string[]) => Promise<Ran>;

export type Installed =
  | { ok: true; entry: string }
  | { ok: false; why: "download"; result: Exclude<DownloadResult, { ok: true }> }
  | { ok: false; why: "unpack" | "signature"; message: string };

export interface InstallInput {
  fetchFn: typeof fetch;
  run: Run;
  /** The folder the driver lives in; one folder per version, so a new pin never overwrites a running one. */
  dir: string;
  pin: Pin;
  target: Target;
  platform: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
}

/** Where the program of a pinned version is, whether or not it is there. */
export const entryOf = (dir: string, pin: Pin, target: Target): string => join(dir, pin.version, target, pin.assets[target].entry);

/** An archive that names a path outside its own folder must never be unpacked. */
export function unsafeEntry(names: string[]): string | undefined {
  return names.find((n) => n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes(".."));
}

/** The team id a macOS signature reports, and nothing is trusted unless the system's own check also passes. */
export async function checkSigner(run: Run, signer: Signer, entry: string, platform: string): Promise<string | undefined> {
  if (signer.kind === "none") return undefined;
  if (signer.kind === "apple") {
    if (platform !== "darwin") return undefined;
    const ok = await run("codesign", ["--verify", "--strict", entry]);
    if (ok.code !== 0) return "The driver's signature is not valid.";
    const shown = await run("codesign", ["-dv", "--verbose=4", entry]);
    const team = /TeamIdentifier=(\S+)/.exec(`${shown.out}\n${shown.err}`)?.[1];
    return team && signer.teamIds.includes(team) ? undefined : "The driver is not signed by the expected publisher.";
  }
  if (platform !== "win32") return undefined;
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath $args[0]; @{status = "$($s.Status)"; subject = "$($s.SignerCertificate.Subject)"} | ConvertTo-Json -Compress`;
  const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps, entry]);
  try {
    const s = JSON.parse(r.out) as { status: string; subject: string };
    const m = /(?:^|,\s*)CN=(?:"((?:[^"]|"")*)"|([^,]+))/.exec(s.subject);
    const cn = m?.[1]?.replace(/""/g, '"') ?? m?.[2];
    return s.status === "Valid" && cn === signer.subject ? undefined : "The driver is not signed by the expected publisher.";
  } catch { return "The driver's signature could not be read."; }
}

/**
 * Fetches the pinned archive (kept only when its hash is the pinned one), unpacks it with the system's own `tar` into a folder of its own and checks the publisher's signature
 * where the system has one. Anything wrong removes what was unpacked, so a program that failed a check is never left where it could be started.
 */
export async function install(i: InstallInput): Promise<Installed> {
  const a: PinnedAsset = i.pin.assets[i.target];
  const entry = entryOf(i.dir, i.pin, i.target);
  const out = join(i.dir, i.pin.version, i.target);
  const archive = join(i.dir, i.pin.version, a.asset);
  mkdirSync(join(i.dir, i.pin.version), { recursive: true });

  if (existsSync(entry)) {
    const bad = await checkSigner(i.run, a.signer, entry, i.platform);
    if (!bad) return { ok: true, entry };
    rmSync(out, { recursive: true, force: true });
  }
  const got = await download(i.fetchFn, { url: `${i.pin.base}/${a.asset}`, dest: archive, sha256: a.sha256, ...(a.size !== undefined ? { size: a.size } : {}), ...(i.signal ? { signal: i.signal } : {}), ...(i.onProgress ? { onProgress: i.onProgress } : {}) });
  if (!got.ok) return { ok: false, why: "download", result: got };

  const listing = await i.run("tar", ["-tf", archive]);
  if (listing.code !== 0) return { ok: false, why: "unpack", message: "The driver's archive could not be read." };
  if (unsafeEntry(listing.out.split(/\r?\n/).filter(Boolean))) return { ok: false, why: "unpack", message: "The driver's archive names a place outside its folder." };
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const unpacked = await i.run("tar", ["-xf", archive, "-C", out]);
  if (unpacked.code !== 0 || !existsSync(entry)) { rmSync(out, { recursive: true, force: true }); return { ok: false, why: "unpack", message: "The driver could not be unpacked." }; }
  if (i.platform !== "win32") chmodSync(entry, 0o755);
  const bad = await checkSigner(i.run, a.signer, entry, i.platform);
  if (bad) { rmSync(out, { recursive: true, force: true }); return { ok: false, why: "signature", message: bad }; }
  return { ok: true, entry };
}
