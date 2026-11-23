import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { download, partBytes } from "./download.ts";
import { listFiles, type Hub, type HubFile } from "./model-hub.ts";

export interface InstalledModel {
  repo: string;
  /** The first (or only) file, as the hub names it. */
  file: string;
  quant: string;
  sizeBytes: number;
  parts: string[];
  /** The SHA-256 of each part, as the hub published them: proof of what was kept. */
  sha256: string[];
}

const dirOf = (local: string): string => join(local, "models");
const registryOf = (local: string): string => join(dirOf(local), "installed.json");

/** Where a file of a repository is kept. The names are the hub's own, taken apart so that none can reach outside the folder. */
export function pathOf(local: string, repo: string, file: string): string | undefined {
  const bits = file.split("/");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || bits.some((b) => !b || b === "." || b === "..") || file.includes("\\") || file.includes("\0")) return undefined;
  return join(dirOf(local), repo.replace("/", "--"), ...bits);
}

export function installedModels(local: string): InstalledModel[] {
  try { return (JSON.parse(readFileSync(registryOf(local), "utf8")) as InstalledModel[]).filter((m) => m.parts.every((p) => { const at = pathOf(local, m.repo, p); return at !== undefined && existsSync(at); })); } catch { return []; }
}

function save(local: string, items: InstalledModel[]): void {
  mkdirSync(dirOf(local), { recursive: true });
  writeFileSync(registryOf(local), JSON.stringify(items, null, 2));
}

export type PullState = { state: "downloading"; bytes: number; total: number } | { state: "paused"; bytes: number; total: number } | { state: "nodisk"; error: string } | { state: "done"; bytes: number; total: number } | { state: "failed"; error: string } | { state: "running" } | { state: "idle" };

export interface PullInput {
  hub: Hub;
  repo: string;
  file: string;
  token?: string;
  local: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  freeBytes: () => number | undefined;
  onState: (s: PullState) => void;
}

const MB = 1024 * 1024;

/**
 * Fetches a model: every part, each proven by the SHA-256 the hub published for it, the disk checked for all of them before the first byte, the bytes already there
 * asked past. A part whose hash is wrong is deleted and the model is not kept. Pausing leaves the parts for a later start, cancelling takes them away.
 */
export async function pullModel(i: PullInput): Promise<{ ok: true } | { ok: false; why: "paused" | "cancelled" | "nodisk" | "failed"; error: string }> {
  const files = await listFiles(i.fetchFn, i.hub, i.repo, false, i.token);
  const fail = (why: "paused" | "cancelled" | "nodisk" | "failed", error: string) => { i.onState(why === "paused" ? { state: "paused", bytes: 0, total: 0 } : why === "nodisk" ? { state: "nodisk", error } : why === "cancelled" ? { state: "idle" } : { state: "failed", error }); return { ok: false as const, why, error }; };
  if ("error" in files) return fail("failed", files.error);
  const model: HubFile | undefined = files.find((f) => f.file === i.file);
  if (!model) return fail("failed", "The model hub does not have that file.");
  if (model.parts.some((p) => !p.sha256)) return fail("failed", "The model hub did not publish a checksum for this file, so it is not fetched.");
  const total = model.sizeBytes;
  const dests = model.parts.map((p) => pathOf(i.local, i.repo, p.path));
  if (dests.some((d) => d === undefined)) return fail("failed", "That file name is not one that can be kept.");

  // The room for everything that is still to come, before anything is fetched.
  const todo = model.parts.reduce((n, p, k) => n + (existsSync(dests[k]!) ? 0 : p.sizeBytes - Math.min(partBytes(dests[k]!), p.sizeBytes)), 0);
  const free = i.freeBytes();
  const need = todo + Math.max(512 * MB, Math.floor(total * 0.02));
  if (free !== undefined && todo > 0 && free < need) return fail("nodisk", `There is not enough room on the disk: ${Math.ceil(need / MB)} MB are needed and ${Math.floor(free / MB)} MB are free.`);

  let before = 0;
  for (const [k, part] of model.parts.entries()) {
    const dest = dests[k]!;
    if (existsSync(dest)) { before += part.sizeBytes; continue; }
    i.onState({ state: "downloading", bytes: before + partBytes(dest), total });
    const got = await download(i.fetchFn, {
      url: `${i.hub.base}/${i.repo}/resolve/main/${part.path}`, dest, sha256: part.sha256!, size: part.sizeBytes,
      ...(i.token ? { headers: { authorization: `Bearer ${i.token}` } } : {}), ...(i.signal ? { signal: i.signal } : {}),
      onProgress: (bytes) => i.onState({ state: "downloading", bytes: before + bytes, total }),
    });
    if (!got.ok) {
      if (got.why === "paused") { i.onState({ state: "paused", bytes: before + partBytes(dest), total }); return { ok: false, why: "paused", error: "paused" }; }
      if (got.why === "cancelled") { for (const d of dests) if (d) { try { rmSync(`${d}.part`, { force: true }); } catch { /* none */ } } return fail("cancelled", "cancelled"); }
      if (got.why === "nodisk") return fail("nodisk", `There is not enough room on the disk: ${Math.ceil(got.needBytes / MB)} MB are needed and ${Math.floor(got.freeBytes / MB)} MB are free.`);
      if (got.why === "wrong") { for (const d of dests) if (d) rmSync(d, { force: true }); return fail("failed", `${part.path} is not the file the model hub published (its hash is different): it was deleted.`); }
      return fail("failed", "message" in got ? got.message : "The download did not finish.");
    }
    before += part.sizeBytes;
  }
  const kept = installedModels(i.local).filter((m) => !(m.repo === i.repo && m.file === i.file));
  save(i.local, [...kept, { repo: i.repo, file: i.file, quant: model.quant, sizeBytes: total, parts: model.parts.map((p) => p.path), sha256: model.parts.map((p) => p.sha256!) }]);
  i.onState({ state: "done", bytes: total, total });
  return { ok: true };
}

/** Takes a model away: its files, and what was written down of it; the folders left empty go too. */
export function removeModel(local: string, repo: string, file: string): boolean {
  const all = (() => { try { return JSON.parse(readFileSync(registryOf(local), "utf8")) as InstalledModel[]; } catch { return []; } })();
  const m = all.find((x) => x.repo === repo && x.file === file);
  const parts = m?.parts ?? [file];
  for (const p of parts) {
    const at = pathOf(local, repo, p);
    if (!at) continue;
    rmSync(at, { force: true }); rmSync(`${at}.part`, { force: true });
    for (let d = dirname(at); d.startsWith(dirOf(local)) && d !== dirOf(local); d = dirname(d)) { try { if (readdirSync(d).length === 0) rmdirSync(d); else break; } catch { break; } }
  }
  if (m) save(local, all.filter((x) => x !== m));
  return !!m;
}

/** Takes away what a download that was stopped left (every part of the model, not the finished ones of another). */
export function cleanParts(local: string, repo: string, file: string): void {
  const at = pathOf(local, repo, file);
  if (!at) return;
  const base = file.split("/").pop()!.replace(/-\d{5}-of-\d{5}\.gguf$/i, "").replace(/\.gguf$/i, "");
  try { for (const e of readdirSync(dirname(at))) if (e.endsWith(".part") && e.startsWith(base)) rmSync(join(dirname(at), e), { force: true }); } catch { /* the folder is not there */ }
}
