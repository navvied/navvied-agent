import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { download, partBytes, partOf } from "../src/download.ts";
import { remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterAll(() => { dirs.forEach(remove); stops.forEach((f) => f()); });
const dir = (): string => { const d = tempDir(); dirs.push(d); return d; };

const bytes = new Uint8Array(300_000).map((_, i) => (i * 31 + 7) % 251);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const SHA = sha(bytes);

/** A server of one file that records what it was asked, honours `Range` unless told not to, and can be told to stall after some bytes. */
function server(o: { ranges?: boolean; stallAfter?: number; body?: Uint8Array } = {}) {
  const asked: (string | null)[] = [];
  const auths: (string | null)[] = [];
  const body = o.body ?? bytes;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const s = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 30,
    fetch(req) {
      const range = req.headers.get("range");
      asked.push(range);
      auths.push(req.headers.get("authorization"));
      const m = /bytes=(\d+)-/.exec(range ?? "");
      const from = o.ranges !== false && m ? Number(m[1]) : 0;
      if (from >= body.length) return new Response("", { status: 416 });
      const part = body.slice(from);
      const stream = new ReadableStream({
        async start(c) {
          const cut = o.stallAfter !== undefined && from === 0 ? o.stallAfter : part.length;
          c.enqueue(part.slice(0, cut));
          if (cut < part.length) { await gate; c.enqueue(part.slice(cut)); }
          c.close();
        },
      });
      const status = o.ranges !== false && m ? 206 : 200;
      return new Response(stream, { status, headers: { "content-length": String(part.length), ...(status === 206 ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}) } });
    },
  });
  stops.push(() => { release?.(); s.stop(true); });
  return { url: `http://127.0.0.1:${s.port}/f`, asked, auths, release: () => release?.() };
}

describe("a file sent from another address", () => {
  test("the token goes to the address that was asked and not on to the one it points to; the range goes on, and the file is whole and proven", async () => {
    const other = server();
    const seen: Record<string, string | null>[] = [];
    const first = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push({ auth: req.headers.get("authorization"), range: req.headers.get("range") }); return new Response("", { status: 302, headers: { location: other.url } }); } });
    stops.push(() => first.stop(true));
    const dest = join(dir(), "f.bin");
    writeFileSync(partOf(dest), bytes.slice(0, 1000));
    const r = await download(fetch, { url: `http://127.0.0.1:${first.port}/f`, dest, sha256: SHA, size: bytes.length, headers: { authorization: "Bearer secret-token" } });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ auth: "Bearer secret-token", range: "bytes=1000-" }]);
    expect(other.asked).toEqual(["bytes=1000-"]);
    expect(other.auths).toEqual([null]);
  });
});

describe("a file that is fetched", () => {
  test("is put in its place whole and with the hash that was promised, with the part gone and the progress told to the end", async () => {
    const s = server(), dest = join(dir(), "a", "f.bin");
    const seen: [number, number][] = [];
    const r = await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length, onProgress: (b, t) => seen.push([b, t]) });
    expect(r).toEqual({ ok: true, bytes: bytes.length });
    expect(sha(new Uint8Array(readFileSync(dest)))).toBe(SHA);
    expect(existsSync(partOf(dest))).toBe(false);
    expect(seen.at(-1)).toEqual([bytes.length, bytes.length]);
  });

  test("resumes where the part ends: only the rest is asked for and sent", async () => {
    const s = server(), dest = join(dir(), "f.bin");
    writeFileSync(partOf(dest), bytes.slice(0, 100_000));
    const r = await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length });
    expect(r.ok).toBe(true);
    expect(s.asked).toEqual(["bytes=100000-"]);
    expect(sha(new Uint8Array(readFileSync(dest)))).toBe(SHA);
  });

  test("starts again when the server sends the whole file although a part was asked past, and when the part is longer than the file", async () => {
    const s = server({ ranges: false }), dest = join(dir(), "f.bin");
    writeFileSync(partOf(dest), bytes.slice(0, 50_000));
    expect((await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length })).ok).toBe(true);
    const dest2 = join(dir(), "g.bin");
    writeFileSync(partOf(dest2), new Uint8Array(bytes.length + 10));
    const s2 = server();
    expect((await download(fetch, { url: s2.url, dest: dest2, sha256: SHA, size: bytes.length })).ok).toBe(true);
    expect(s2.asked).toEqual([null]);
  });

  test("with another hash than the one promised it is deleted, not kept, and nothing is left behind", async () => {
    const s = server(), dest = join(dir(), "f.bin");
    const r = await download(fetch, { url: s.url, dest, sha256: "0".repeat(64), size: bytes.length });
    expect(r).toEqual({ ok: false, why: "wrong", got: SHA });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(partOf(dest))).toBe(false);
  });

  test("is not started when the disk has no room, and nothing is asked of the server", async () => {
    const s = server(), dest = join(dir(), "f.bin");
    const r = await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length, freeBytes: () => 1000, spare: 500 });
    expect(r).toEqual({ ok: false, why: "nodisk", needBytes: bytes.length + 500, freeBytes: 1000 });
    expect(s.asked).toEqual([]);
  });

  test("the part that is there counts: only what is still to come must fit", async () => {
    const s = server(), dest = join(dir(), "f.bin");
    writeFileSync(partOf(dest), bytes.slice(0, 250_000));
    expect((await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length, freeBytes: () => 60_000, spare: 1000 })).ok).toBe(true);
  });

  test("paused leaves the part to go on from; cancelled takes it away", async () => {
    const s = server({ stallAfter: 120_000 }), dest = join(dir(), "f.bin");
    const pause = new AbortController();
    const first = download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length, signal: pause.signal });
    await until(() => partBytes(dest) >= 120_000);
    pause.abort("pause");
    expect(await first).toEqual({ ok: false, why: "paused" });
    expect(partBytes(dest)).toBeGreaterThanOrEqual(120_000);
    s.release();
    const again = await download(fetch, { url: s.url, dest, sha256: SHA, size: bytes.length });
    expect(again.ok).toBe(true);
    expect(s.asked.at(-1)).toMatch(/^bytes=\d+-$/);

    const s2 = server({ stallAfter: 100_000 }), dest2 = join(dir(), "g.bin");
    const stop = new AbortController();
    const second = download(fetch, { url: s2.url, dest: dest2, sha256: SHA, size: bytes.length, signal: stop.signal });
    await until(() => partBytes(dest2) >= 100_000);
    stop.abort("cancel");
    expect(await second).toEqual({ ok: false, why: "cancelled" });
    expect(existsSync(partOf(dest2))).toBe(false);
  });

  test("a server that answers with an error, and one that cannot be reached, say so", async () => {
    const dest = join(dir(), "f.bin");
    const bad = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 404 }) });
    stops.push(() => bad.stop(true));
    expect(await download(fetch, { url: `http://127.0.0.1:${bad.port}/x`, dest, sha256: SHA })).toEqual({ ok: false, why: "failed", message: "The server answered 404." });
    expect(await download(fetch, { url: "http://127.0.0.1:1/x", dest, sha256: SHA })).toEqual({ ok: false, why: "failed", message: "The connection to the server failed." });
  });
});
