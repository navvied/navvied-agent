import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Media, type MediaKind, type VisionRoute } from "../src/index.ts";
import { removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
export const scratch = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-media-test-")); dirs.push(d); return d; };
export const cleanScratch = (): Promise<void> => removeTrees(dirs);

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A program for a test: a shell script, so tests that use one do not run on Windows. */
export function program(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export interface Seen { method: string; path: string; auth: string | null; body: Record<string, unknown> }

/** A localhost fake of the documented routes (docs/HOSTED.md): the kinds it lists, and every request it got. */
export function fakeService(listing: { kind: MediaKind; provider: "free" | "paid" }[], token = "tok"): { url: string; seen: Seen[]; stop(): void } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: { message: "Sign in again." } }, { status: 401 });
      if (req.method === "GET") return Response.json({ tools: listing });
      if (body.prompt === "refuse") return Response.json({ error: { message: "You have used today's pictures." } }, { status: 429 });
      if (path.endsWith("/stt")) return Response.json({ text: "hello there" });
      if (path.endsWith("/tts")) return new Response(new Uint8Array([82, 73, 70, 70, 1, 2, 3]), { headers: { "content-type": "audio/wav", "x-navvied-seconds": "2" } });
      if (path.endsWith("/image")) return new Response(PNG, { headers: { "content-type": "image/png" } });
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/api/media`, seen, stop: () => { void server.stop(true); } };
}

export const remote = (url: string, token = "tok"): Media => new Media({ server: () => ({ url, token }) });

export interface Looks { images: number; question: string }
/** A model that sees pictures, as a route: it says what it was shown. */
export function fakeLook(answer = "A red square."): { route: VisionRoute; asked: Looks[] } {
  const asked: Looks[] = [];
  return { asked, route: async ({ images, question }) => { asked.push({ images: images.length, question }); return answer; } };
}
