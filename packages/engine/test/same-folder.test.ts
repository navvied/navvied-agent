import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePaths } from "../src/index.ts";
import { outsideProject } from "../src/where.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { outsideFolder } from "./outside.ts";

const away = outsideFolder();
const real = join(away, "real"), link = join(away, "link"), elsewhere = join(away, "elsewhere");
for (const folder of [join(real, "project"), join(real, "scratch"), elsewhere]) mkdirSync(folder, { recursive: true });
symlinkSync(real, link, "junction");
symlinkSync(elsewhere, join(real, "project", "way-out"), "junction");
afterAll(hook("same-folder removes what it made", async () => { await removeTree(away); }), HOOK_MS);

const outside = (target: string, cwd: string): boolean => outsideProject(target, cwd, nativePaths);

describe("a folder is the same folder by whichever of its names it is called", () => {
  test("the project reached through a link and by its real name are one project, for files that exist and files yet to be written", () => {
    expect([outside(join(real, "project", "a.txt"), join(link, "project")), outside(join(link, "project", "new", "b.txt"), join(real, "project"))]).toEqual([false, false]);
  });

  test("a temporary folder that is known by a linked name is scratch space under its real name too", () => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = join(link, "scratch");
    try {
      expect(tmpdir()).toBe(join(link, "scratch"));
      expect(outside(join(real, "scratch", "x.txt"), join(away, "elsewhere"))).toBe(false);
    } finally { if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before; }
  });

  test("a link inside the project that leads out of it is outside", () => {
    expect(outside(join(real, "project", "way-out", "c.txt"), join(real, "project"))).toBe(true);
    expect(outside(join(real, "project", "kept.txt"), join(real, "project"))).toBe(false);
    expect(outside(join(real, "other.txt"), join(real, "project"))).toBe(true);
  });
});
