import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { PictureInfo } from "@navvied/protocol";
import { Media, MediaShelf, type MediaProvider } from "../src/index.ts";
import { keepPicture, pictureSize } from "../src/tools/picture-file.ts";
import { conversation, tool } from "./files-support.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { cleanScratch, scratch } from "./media-support.ts";

afterAll(async () => { await cleanScratch(); await cleanupAll(); });

const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number): Uint8Array => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 0, 0]);
const webpLossless = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(30);
  b.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from("VP8L")]);
  new DataView(b.buffer).setUint32(21, ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), true);
  return b;
};

describe("the size of a picture", () => {
  test("it is read from the header of a png, a jpeg and a webp, and is none for anything else or a cut header", () => {
    expect(pictureSize(png(1024, 576))).toEqual({ width: 1024, height: 576 });
    expect(pictureSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pictureSize(webpLossless(300, 200))).toEqual({ width: 300, height: 200 });
    expect(pictureSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(pictureSize(png(1, 1).subarray(0, 12))).toBeUndefined();
    expect(pictureSize(jpeg(5, 5).subarray(0, 8))).toBeUndefined();
  });
});

describe("the pictures a tool saves", () => {
  test("MakeImage says path, bytes, width and height to the step, and the model's text is the same as before", async () => {
    const dir = scratch();
    const reports: { picture?: PictureInfo; media?: unknown }[] = [];
    const bytes = png(1024, 576);
    const provider: MediaProvider<"image"> = { kind: "image", id: "fake", paid: false, local: true, run: async () => ({ bytes, mime: "image/png" }) };
    const media = new Media(); (media as unknown as { pick: Media["pick"] }).pick = ((k: string) => (k === "image" ? provider : undefined)) as Media["pick"];
    const ctx = conversation(dir, { media, report: (m) => { reports.push(m); } });
    expect(await tool("MakeImage").run({ prompt: "a fox", size: "wide" }, ctx)).toBe(`Saved ${join(dir, "image.png")} (33 bytes).`);
    expect(reports).toEqual([{ picture: { path: join(dir, "image.png"), bytes: 33, width: 1024, height: 576, mime: "image/png" }, media: { path: join(dir, "image.png"), mime: "image/png" } }]);
  });

  test("with no folder given nothing is kept; with one, a file of its own is made, owner-only folder, and only the newest 50 stay", () => {
    const dir = scratch();
    const reports: { picture?: PictureInfo }[] = [];
    const ctx = conversation(dir, { report: (m) => { reports.push(m); } });
    expect(keepPicture(ctx, "browser", png(2, 2), "image/png", "png")).toBeUndefined();
    const kept = conversation(dir, { folder: (t) => join(dir, "tools", t), report: (m) => { reports.push(m); } });
    for (let i = 0; i < 53; i++) {
      const info = keepPicture(kept, "browser", png(3, 4), "image/png", "png", Date.UTC(2026, 10, 25, 9, 0, i))!;
      utimesSync(info.path, new Date(Date.UTC(2026, 10, 25, 9, 0, i)), new Date(Date.UTC(2026, 10, 25, 9, 0, i)));
    }
    const files = readdirSync(join(dir, "tools", "browser"));
    expect(files).toHaveLength(50);
    expect(existsSync(join(dir, "tools", "browser", "shot-2026-11-25T09-00-00-000Z.png"))).toBe(false);
    expect(existsSync(join(dir, "tools", "browser", "shot-2026-11-25T09-00-52-000Z.png"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "tools", "browser")).mode & 0o700).toBe(0o700);
    expect(reports.at(-1)!.picture).toMatchObject({ width: 3, height: 4, bytes: 33 });
  });
});

describe("the step's event", () => {
  test("the tool event of a made picture carries it, and its output stays the short text", async () => {
    const bytes = png(512, 512);
    const provider: MediaProvider<"image"> = { kind: "image", id: "fake", paid: false, local: true, run: async () => ({ bytes, mime: "image/png" }) };
    const media = new Media(); (media as unknown as { pick: Media["pick"] }).pick = ((k: string) => (k === "image" ? provider : undefined)) as Media["pick"];
    const shelf = new MediaShelf();
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "MakeImage", args: { prompt: "a fox", file_path: "fox.png" } }] } : { text: "done" }), { media, shelf });
    await r.turn(prompt("draw a fox"));
    const done = r.of("tool").find((e) => e.name === "MakeImage" && e.status === "done")!;
    expect(done.picture).toEqual({ path: join(r.dir, "fox.png"), bytes: 33, width: 512, height: 512, mime: "image/png" });
    expect(done.output).toBe(`Saved ${join(r.dir, "fox.png")} (33 bytes).`);
    expect(done.media).toMatchObject({ kind: "image", mime: "image/png", bytes: 33, name: "fox.png", width: 512, height: 512 });
    expect((shelf.read(done.media!.id) as { data: Buffer }).data.length).toBe(33);
    r.cleanup();
  });
});
