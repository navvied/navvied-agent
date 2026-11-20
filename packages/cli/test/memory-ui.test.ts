import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFile, memoryPathsFor, memoryRows } from "../src/memory-ui.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-memui-")); dirs.push(d); return d; };
afterAll(hook("memory-ui removes what it made", async () => { await removeTrees(dirs);; }), HOOK_MS);

describe("the memory screen", () => {
  test("notes for every project sit next to the configuration, notes for a project in its own .navvied folder", () => {
    expect(memoryPathsFor("/work/shop", "/home/ana/.config/navvied/config.json")).toEqual({ user: join("/home/ana/.config/navvied", "memory.md"), project: join("/work/shop", ".navvied", "memory.md") });
  });
  test("rows in the approved order, with counts in words and what is missing said plainly", () => {
    const cwd = temp(), conf = temp();
    const paths = memoryPathsFor(cwd, join(conf, "config.json"));
    let rows = memoryRows(paths, cwd);
    expect(rows.map((r) => r.label)).toEqual(["This project's notes", "Instructions for this project", "Add a note", "Notes for all my projects"]);
    expect(rows[0]!.hint).toBe("Nothing kept yet. Opens the file.");
    expect(rows[1]!.hint).toBe("NAVVIED.md does not exist yet. Rules it follows every time. Opens the file.");
    mkdirSync(join(cwd, ".navvied"));
    writeFileSync(paths.project, "# x\n\n- a: one\n- b: two\n");
    writeFileSync(join(cwd, "NAVVIED.md"), "Be brief.");
    writeFileSync(paths.user!, "- c: one\n");
    rows = memoryRows(paths, cwd);
    expect(rows[0]!.hint).toBe("2 notes the agent kept. Opens the file.");
    expect(rows[1]!.hint).toBe("NAVVIED.md. Rules it follows every time. Opens the file.");
    expect(rows[3]!.hint).toBe("1 note. Your own habits, kept on this computer. Opens the file.");
  });
  test("a file is made with its heading before it is opened, and an existing one is left alone", () => {
    const dir = temp();
    const file = join(dir, "deep", "memory.md");
    ensureFile(file, "# Heading\n\n");
    expect(readFileSync(file, "utf8")).toBe("# Heading\n\n");
    writeFileSync(file, "mine");
    ensureFile(file, "# Heading\n\n");
    expect(readFileSync(file, "utf8")).toBe("mine");
    expect(existsSync(join(dir, "deep"))).toBe(true);
  });
});
