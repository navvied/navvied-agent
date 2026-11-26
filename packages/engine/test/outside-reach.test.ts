import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PermMode } from "@navvied/protocol";
import { Rules, judge, nativePaths, type JudgeInput } from "../src/index.ts";
import { place } from "../src/tools/util.ts";
import { expandHome, homeFrom, outsideProject } from "../src/where.ts";

const cwd = "/work/project";
const MODES: PermMode[] = ["ask", "edits", "plan", "auto", "bypass"];
const READERS = ["Read", "Grep", "Glob"];
const row = (tool: string, args: Record<string, unknown>, more: Partial<JudgeInput> = {}) =>
  MODES.map((mode) => judge({ mode, tool: { name: tool, readOnly: READERS.includes(tool) }, args, cwd, allowed: new Set(), knownUrl: () => true, ...more }).kind).join(" ");
const home = { ...nativePaths, home: "/home/pat" };
const ASKED = "ask ask go ask go";
const A_SYSTEM_FILE = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts";

describe("one place decides what is outside the project, for every tool", () => {
  test("a file the program writes outside the project is asked about in Ask, Edits and Auto, by every tool that writes", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(row(tool, { file_path: "/home/pat/.local/bin/x", content: "x" }, { paths: home })).toBe(ASKED);
    expect(row("apply_patch", { patch: "*** Begin Patch\n*** Add File: /home/pat/.config/autostart/x.desktop\n+x\n*** End Patch" }, { paths: home })).toBe(ASKED);
    expect(row("Write", { file_path: "../elsewhere.txt", content: "x" })).toBe(ASKED);
  });

  test("`~` is the home the program was given: the same line is inside the project when that home is inside it, outside when it is not", () => {
    expect(row("Write", { file_path: "~/.local/bin/x", content: "x" }, { paths: home })).toBe(ASKED);
    expect(row("Write", { file_path: "~/.local/bin/x", content: "x" }, { paths: { ...nativePaths, home: `${cwd}/home` } })).toBe("ask go go go go");
    expect(row("Write", { file_path: "$HOME/x", content: "x" }, { paths: { ...nativePaths, home: `${cwd}/home` } })).toBe("ask go go go go");
  });

  test("the project, scratch space and the null device are not outside; a system folder is stopped in every mode", () => {
    expect(row("Write", { file_path: "src/a.ts", content: "x" })).toBe("ask go go go go");
    expect(row("Write", { file_path: "/tmp/x/a.ts", content: "x" })).toBe("ask go go go go");
    expect(row("Write", { file_path: join(tmpdir(), "a.ts"), content: "x" })).toBe("ask go go go go");
    expect(row("Write", { file_path: A_SYSTEM_FILE, content: "x" })).toBe("stop stop stop stop stop");
  });

  test("a rule that allows the file is the person's word, and what was allowed for a folder stays allowed for it", () => {
    const rules = new Rules({ allow: ["Write(/home/pat/notes/**)"], ask: [], deny: [] }, cwd, home);
    expect(row("Write", { file_path: "~/notes/a.md", content: "x" }, { rules, paths: home })).toBe("go go go go go");
    const first = judge({ mode: "auto", tool: { name: "Write", readOnly: false }, args: { file_path: "~/.local/bin/x", content: "x" }, cwd, allowed: new Set(), knownUrl: () => true, paths: home });
    if (first.kind !== "ask") throw new Error("expected a question");
    expect(first.scope.key).toBe("outside:/home/pat/.local/bin");
    expect(judge({ mode: "auto", tool: { name: "Write", readOnly: false }, args: { file_path: "~/.local/bin/y", content: "x" }, cwd, allowed: new Set([first.scope.key]), knownUrl: () => true, paths: home }).kind).toBe("go");
  });

  test("a search through a place outside the project is asked about like a write, in Auto too; a look inside or in scratch space is not", () => {
    expect(row("Grep", { pattern: "key", path: "/home/pat" }, { paths: home })).toBe(ASKED);
    expect(row("Grep", { pattern: "key", path: "~" }, { paths: home })).toBe(ASKED);
    expect(row("Glob", { pattern: "**/*", path: "/" }, { paths: home })).toBe(ASKED);
    expect(row("Grep", { pattern: "key" })).toBe("go go go go go");
    expect(row("Grep", { pattern: "key", path: "src" })).toBe("go go go go go");
    expect(row("Grep", { pattern: "key", path: "/tmp/build" })).toBe("go go go go go");
  });

  test("the same for a shell command that searches: find, recursive grep, rg", () => {
    for (const command of ["find ~ -name '*.pem'", "find / -name id_rsa", "grep -rn token /home/pat", "grep -R token ~/", "rg token ../", "rg -n token /home/pat/.config", "fd secret /home/pat"]) expect(`${command}: ${row("Bash", { command }, { paths: home })}`).toBe(`${command}: ask ask go ask go`);
    for (const command of ["find . -name '*.ts'", "find /tmp -name x", "grep -rn token src", "grep -rn token .", "rg token", "rg token src /tmp", "grep token /home/pat/file.txt", "ls ~", "find src -type f | head"]) expect(`${command}: ${row("Bash", { command }, { paths: home })}`).toBe(`${command}: go go go go go`);
  });

  test("a search of a folder the program keeps things in is free, as a look is", () => {
    expect(row("Grep", { pattern: "x", path: "/home/pat/.navvied/notes" }, { paths: home, readable: ["/home/pat/.navvied/notes"] })).toBe("go go go go go");
  });
});

describe("`~` is the home of the environment the program was given", () => {
  test("homeFrom follows HOME, then USERPROFILE, in the environment it is given", () => {
    expect(homeFrom({ HOME: "/srv/h" })).toBe("/srv/h");
    expect(homeFrom({ USERPROFILE: "C:/Users/p" })).toBe("C:/Users/p");
    expect(homeFrom({ HOME: "/srv/h", USERPROFILE: "x" })).toBe("/srv/h");
  });
  test("expandHome and outsideProject use it, not the account's home", () => {
    expect(expandHome("~/a", "/srv/h")).toBe("/srv/h/a");
    expect(expandHome("$HOME", "/srv/h/")).toBe("/srv/h");
    expect(expandHome("~x/a", "/srv/h")).toBe("~x/a");
    expect(outsideProject("~/a", cwd, { ...nativePaths, home: `${cwd}/h` })).toBe(false);
    expect(outsideProject("~/a", cwd, { ...nativePaths, home: "/srv/h" })).toBe(true);
  });
  test("a tool works on the very path the permission check judged, in this computer's own spelling", () => {
    const folder = resolve("/work/project");
    for (const written of [`${folder}/src/../b.ts`, `${folder}//src/./a.ts`, "~//notes/../a.md"]) expect(place({ cwd: folder, home: resolve("/home/pat") }, written)).toBe(resolve(folder, written.replace("~", resolve("/home/pat"))));
  });

  test("a tool reaches `~` in the home it is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-home-"));
    try {
      expect(place({ cwd: "/work/project", home: dir }, "~/.local/bin/x")).toBe(join(dir, ".local/bin/x"));
      expect(place({ cwd: "/work/project", home: dir }, "src/a.ts")).toBe(resolve("/work/project", "src/a.ts"));
      expect(() => place({ cwd: "/work/project", root: "/work/project", home: dir }, "~/a")).toThrow(/outside the folder/);
      expect(existsSync(join(dir, ".local"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
