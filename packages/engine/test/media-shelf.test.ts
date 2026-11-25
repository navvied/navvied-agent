import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaRef } from "@navvied/protocol";
import { MediaShelf, SHELF, type Tool } from "../src/index.ts";
import { keepPicture } from "../src/tools/picture-file.ts";
import { save } from "../src/tools/media-files.ts";
import { conversation } from "./files-support.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { cleanScratch, scratch } from "./media-support.ts";

afterAll(async () => { await cleanScratch(); await cleanupAll(); });

const win = process.platform === "win32";
const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
};

describe("the shelf of what the engine made", () => {
  test("a picture, a sound and a video get a reference with what a page needs to show them, and never a path", () => {
    const dir = scratch(), shelf = new MediaShelf();
    writeFileSync(join(dir, "a.png"), png(640, 480));
    writeFileSync(join(dir, "a.wav"), "RIFFxxxx");
    writeFileSync(join(dir, "a.mp4"), "video bytes");
    const image = shelf.keep({ path: join(dir, "a.png"), mime: "image/png" })!;
    const sound = shelf.keep({ path: join(dir, "a.wav"), mime: "audio/wav", seconds: 2 })!;
    const video = shelf.keep({ path: join(dir, "a.mp4"), mime: "video/mp4", seconds: 7 })!;
    expect(image).toMatchObject({ kind: "image", mime: "image/png", bytes: 33, name: "a.png", width: 640, height: 480 });
    expect(sound).toMatchObject({ kind: "audio", name: "a.wav", seconds: 2 });
    expect(video).toMatchObject({ kind: "video", bytes: 11, seconds: 7 });
    expect(new Set([image.id, sound.id, video.id]).size).toBe(3);
    expect(JSON.stringify([image, sound, video])).not.toContain(dir);
    expect(image.id).toMatch(/^[0-9a-f]{24}$/);
  });

  test("what a page can show is only a picture, a sound or a video, and a file with nothing in it or too large is not kept", () => {
    const dir = scratch(), shelf = new MediaShelf();
    writeFileSync(join(dir, "notes.txt"), "text");
    writeFileSync(join(dir, "empty.png"), "");
    writeFileSync(join(dir, "huge.mp4"), "x");
    truncateSync(join(dir, "huge.mp4"), SHELF.file + 1);
    expect(shelf.keep({ path: join(dir, "notes.txt"), mime: "text/plain" })).toBeUndefined();
    expect(shelf.keep({ path: join(dir, "empty.png"), mime: "image/png" })).toBeUndefined();
    expect(shelf.keep({ path: join(dir, "huge.mp4"), mime: "video/mp4" })).toBeUndefined();
    expect(shelf.keep({ path: join(dir, "nothing.png"), mime: "image/png" })).toBeUndefined();
    expect(shelf.keep({ path: dir, mime: "image/png" })).toBeUndefined();
  });

  test.skipIf(win)("a link is not kept, and a file that was kept and then swapped for a link, or for another file, is not read", () => {
    const dir = scratch(), shelf = new MediaShelf();
    writeFileSync(join(dir, "secret.txt"), "a private secret");
    symlinkSync(join(dir, "secret.txt"), join(dir, "link.png"));
    expect(shelf.keep({ path: join(dir, "link.png"), mime: "image/png" })).toBeUndefined();

    writeFileSync(join(dir, "pic.png"), png(1, 1));
    const ref = shelf.keep({ path: join(dir, "pic.png"), mime: "image/png" })!;
    expect("data" in shelf.read(ref.id)).toBe(true);
    unlinkSync(join(dir, "pic.png"));
    symlinkSync(join(dir, "secret.txt"), join(dir, "pic.png"));
    expect(shelf.read(ref.id)).toEqual({ error: "That file is not there any more." });

    writeFileSync(join(dir, "two.png"), png(1, 1));
    const two = shelf.keep({ path: join(dir, "two.png"), mime: "image/png" })!;
    unlinkSync(join(dir, "two.png"));
    writeFileSync(join(dir, "two.png"), Buffer.concat([png(2, 2), Buffer.from("more")]));
    expect(shelf.read(two.id)).toEqual({ error: "That file changed, so it is not shown." });
    expect(shelf.read(two.id)).toEqual({ error: "That file is not there any more." });
  });

  test("a file is fetched in pieces from any place in it, and the last piece says so; a path is not an id", () => {
    const dir = scratch(), shelf = new MediaShelf();
    const body = Buffer.alloc(SHELF.chunk * 2 + 100);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    writeFileSync(join(dir, "v.mp4"), body);
    const ref = shelf.keep({ path: join(dir, "v.mp4"), mime: "video/mp4" })!;
    const got: Buffer[] = [];
    let offset = 0;
    for (let n = 0; n < 10; n++) {
      const piece = shelf.read(ref.id, offset);
      if ("error" in piece) throw new Error(piece.error);
      expect(piece.offset).toBe(offset);
      got.push(piece.data);
      offset += piece.data.length;
      if (piece.done) break;
    }
    expect(got).toHaveLength(3);
    expect(Buffer.concat(got).equals(body)).toBe(true);
    const middle = shelf.read(ref.id, 1000, 16) as { data: Buffer; done: boolean };
    expect(middle.data.equals(body.subarray(1000, 1016))).toBe(true);
    expect(middle.done).toBe(false);
    expect((shelf.read(ref.id, 0, 10 * SHELF.chunk) as { data: Buffer }).data.length).toBe(SHELF.chunk);
    expect(shelf.read(ref.id, body.length + 5)).toMatchObject({ offset: body.length, done: true });
    expect(shelf.read(join(dir, "v.mp4"))).toEqual({ error: "That file is not there any more." });
    expect(shelf.read("0".repeat(24))).toEqual({ error: "That file is not there any more." });
  });

  test("only the newest files are kept", () => {
    const dir = scratch(), shelf = new MediaShelf();
    mkdirSync(dir, { recursive: true });
    const refs: MediaRef[] = [];
    writeFileSync(join(dir, "p.png"), png(1, 1));
    for (let i = 0; i < SHELF.count + 3; i++) { const path = join(dir, `p${i}.png`); linkSync(join(dir, "p.png"), path); refs.push(shelf.keep({ path, mime: "image/png" })!); }
    expect("error" in shelf.read(refs[0]!.id)).toBe(true);
    expect("error" in shelf.read(refs[2]!.id)).toBe(true);
    expect("error" in shelf.read(refs[3]!.id)).toBe(false);
    expect("error" in shelf.read(refs.at(-1)!.id)).toBe(false);
  });
});

describe("what steps tell the shelf", () => {
  test("a Browser screenshot, a made picture and a spoken text each report the file they saved, with its type and length", () => {
    const dir = scratch();
    const reports: { media?: unknown }[] = [];
    const ctx = conversation(dir, { folder: (t) => join(dir, "tools", t), report: (m) => { reports.push(m); } });
    keepPicture(ctx, "browser", png(3, 4), "image/jpeg", "jpg", Date.UTC(2026, 10, 25, 9, 0, 0));
    expect(reports.at(-1)!.media).toEqual({ path: join(dir, "tools", "browser", "shot-2026-11-25T09-00-00-000Z.jpg"), mime: "image/jpeg" });
    expect(save(ctx, { file_path: "hello.wav" }, "speech", "wav", { bytes: Buffer.from("RIFF"), mime: "audio/wav", seconds: 3 })).toContain("Saved");
    expect(reports.at(-1)!.media).toEqual({ path: join(dir, "hello.wav"), mime: "audio/wav", seconds: 3 });
    save(ctx, { file_path: "clip.mp4" }, "video", "mp4", { bytes: Buffer.from("mp4"), mime: "video/mp4" });
    expect(reports.at(-1)!.media).toEqual({ path: join(dir, "clip.mp4"), mime: "video/mp4" });
  });

  test("the tool event of a step that made a file carries its reference, which fetches that file; without a shelf it carries none", async () => {
    const make: Tool = {
      name: "MakeThing", description: "x", readOnly: true, parameters: { type: "object", properties: {} }, title: () => "make",
      run: async (_a, ctx) => { const path = join(ctx.cwd, "made.wav"); writeFileSync(path, "RIFFdata"); ctx.report?.({ media: { path, mime: "audio/wav", seconds: 1 } }); return "ok"; },
    };
    const shelf = new MediaShelf();
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "MakeThing", args: {}, id: "t1" }] } : { text: "done" }), { tools: [make], shelf });
    await r.turn(prompt("go"));
    const done = r.of("tool").find((e) => e.id === "t1" && e.status === "done")!;
    expect(done.media).toMatchObject({ kind: "audio", mime: "audio/wav", bytes: 8, name: "made.wav", seconds: 1 });
    expect(JSON.stringify(done)).not.toContain(r.dir);
    expect(Buffer.from((shelf.read(done.media!.id) as { data: Buffer }).data).toString()).toBe("RIFFdata");
    expect(existsSync(join(r.dir, "made.wav"))).toBe(true);
    r.cleanup();

    const bare = rig((_q, n) => (n === 0 ? { calls: [{ name: "MakeThing", args: {}, id: "t1" }] } : { text: "done" }), { tools: [make] });
    await bare.turn(prompt("go"));
    expect(bare.of("tool").find((e) => e.id === "t1" && e.status === "done")!.media).toBeUndefined();
    bare.cleanup();
  });

});
