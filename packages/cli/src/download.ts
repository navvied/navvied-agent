import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

export interface DownloadInput {
  url: string;
  /** Where the file ends up, only once it is whole and its hash is right; until then the bytes are in `<dest>.part`. */
  dest: string;
  /** The SHA-256 the file must have, from the source that published it. A file that has another is deleted, never kept and never run. */
  sha256: string;
  /** Bytes the file has when it is whole, when the source said so beforehand. */
  size?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (bytes: number, total: number) => void;
  /** Free space of the volume `dest` is on, in bytes, and how much more than the file must stay free. */
  freeBytes?: () => number | undefined;
  spare?: number;
}

export type DownloadResult =
  | { ok: true; bytes: number }
  | { ok: false; why: "nodisk"; needBytes: number; freeBytes: number }
  | { ok: false; why: "paused" | "cancelled" }
  | { ok: false; why: "wrong"; got: string }
  | { ok: false; why: "failed"; message: string };

const GB = 1024 * 1024 * 1024;
export const partOf = (dest: string): string => `${dest}.part`;

/** What of a download is on the disk: the bytes of the part, for a resume. */
export function partBytes(dest: string): number { try { return statSync(partOf(dest)).size; } catch { return 0; } }

/** Takes the part away (a download that is cancelled leaves nothing behind). */
export function cleanPart(dest: string): void { try { unlinkSync(partOf(dest)); } catch { /* nothing there */ } }

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * A request that follows redirects itself: the headers go to the address that was asked for, and only the byte range goes on to another host (the files of a hub are sent
 * from a content network: its servers are not given the person's token).
 */
export async function fetchFollowing(fetchFn: typeof fetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  let at = url, hops = 0;
  const origin = new URL(url).origin;
  for (;;) {
    const same = new URL(at).origin === origin;
    const sent = same ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() === "range"));
    const res = await fetchFn(at, { headers: sent, redirect: "manual", ...(signal ? { signal } : {}) });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      if (++hops > 5) throw new Error("Too many redirects.");
      await res.body?.cancel();
      at = new URL(next, at).toString();
      continue;
    }
    return res;
  }
}

const total = (res: Response, have: number): number | undefined => {
  const range = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
  if (range) return Number(range[1]);
  const len = Number(res.headers.get("content-length"));
  return Number.isFinite(len) && len > 0 ? len + (res.status === 206 ? have : 0) : undefined;
};

/**
 * A file fetched in a way that can be stopped and taken up again: the bytes already there are asked past (`Range`), a server that answers with the whole file
 * starts it again, the disk is checked before anything is written, and the file is put in its place only when its SHA-256 is the one that was promised.
 */
export async function download(fetchFn: typeof fetch, d: DownloadInput): Promise<DownloadResult> {
  const part = partOf(d.dest);
  mkdirSync(dirname(d.dest), { recursive: true });
  let have = partBytes(d.dest);
  const asked = d.size;
  if (asked !== undefined && have > asked) { cleanPart(d.dest); have = 0; }
  const free = d.freeBytes?.();
  if (asked !== undefined && free !== undefined && free < asked - have + (d.spare ?? GB / 2)) return { ok: false, why: "nodisk", needBytes: asked - have + (d.spare ?? GB / 2), freeBytes: Math.max(0, free) };

  if (!(asked !== undefined && have === asked)) {
    let res: Response;
    try { res = await fetchFollowing(fetchFn, d.url, { ...d.headers, ...(have ? { range: `bytes=${have}-` } : {}) }, d.signal); } catch (e) { return aborted(d, e); }
    if (res.status === 416) { cleanPart(d.dest); return download(fetchFn, d); }
    if (!(res.status === 200 || res.status === 206) || !res.body) return { ok: false, why: "failed", message: `The server answered ${res.status}.` };
    if (res.status === 200 && have) have = 0;
    const whole = total(res, have) ?? asked;
    if (whole !== undefined && free !== undefined && free < whole - have + (d.spare ?? GB / 2)) { await res.body.cancel(); return { ok: false, why: "nodisk", needBytes: whole - have + (d.spare ?? GB / 2), freeBytes: Math.max(0, free) }; }
    const file = await open(part, have ? "a" : "w");
    let seen = have, last = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        await file.write(chunk);
        seen += chunk.length;
        const now = Date.now();
        if (d.onProgress && now - last > 200) { last = now; d.onProgress(seen, whole ?? 0); }
      }
    } catch (e) { await file.close(); return aborted(d, e); } finally { await file.close().catch(() => undefined); }
    d.onProgress?.(seen, whole ?? seen);
    if (whole !== undefined && seen < whole) return { ok: false, why: "failed", message: "The connection ended before the file was whole." };
  }
  const got = await sha256Of(part);
  if (got !== d.sha256.toLowerCase()) { cleanPart(d.dest); return { ok: false, why: "wrong", got }; }
  const { rename } = await import("node:fs/promises");
  await rename(part, d.dest);
  return { ok: true, bytes: statSync(d.dest).size };
}

function aborted(d: DownloadInput, e: unknown): DownloadResult {
  if (d.signal?.aborted) {
    if (d.signal.reason === "cancel") { cleanPart(d.dest); return { ok: false, why: "cancelled" }; }
    return { ok: false, why: "paused" };
  }
  return { ok: false, why: "failed", message: e instanceof Error && e.name !== "TypeError" ? e.message : "The connection to the server failed." };
}

export const exists = existsSync;
