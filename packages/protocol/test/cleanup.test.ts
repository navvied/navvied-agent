import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hook, removeTree } from "./support/cleanup.ts";

describe("what a test removes after itself", () => {
  test("a folder with files in it is gone, and one that is not there is not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-cleanup-"));
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "f.txt"), "x");
    await removeTree(dir);
    expect(existsSync(dir)).toBe(false);
    await removeTree(dir);
  });

  test("a hook that fails says its own name in a line the CI turns into an annotation, and still fails", async () => {
    const lines: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.error = () => undefined;
    try { await expect(hook("jobs.test removes its folder", () => { throw Object.assign(new Error("resource busy or locked, rmdir 'C:\\\\x'"), { code: "EBUSY" }); })()).rejects.toThrow("busy"); }
    finally { console.log = log; console.error = error; }
    expect(lines).toEqual(["::error title=hook failed: jobs.test removes its folder::Error EBUSY: resource busy or locked, rmdir 'C:\\\\x'"]);
  });

  test("a hook that is still running when its time is up says its own name instead of being cut off as \"(unnamed)\"", async () => {
    const lines: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.error = () => undefined;
    try { await expect(hook("server.test stops its server", () => new Promise(() => undefined), 30)()).rejects.toThrow("still running after 0.03 s"); }
    finally { console.log = log; console.error = error; }
    expect(lines).toEqual(["::error title=hook failed: server.test stops its server::Error: still running after 0.03 s"]);
  });

  test("a hook that works says nothing", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { await hook("fine", () => undefined)(); } finally { console.log = log; }
    expect(lines).toEqual([]);
  });
});
