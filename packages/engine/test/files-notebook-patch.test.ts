import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";
import { parsePatch, patchPaths, seek } from "../src/tools/apply-patch.ts";
import { cleanFiles, conversation, tool, workdir } from "./files-support.ts";

afterAll(hook("files-notebook-patch removes what it made", cleanFiles), HOOK_MS);
const nb = tool("NotebookEdit"), read = tool("Read"), patch = tool("apply_patch");

const notebook = (): string => JSON.stringify({
  cells: [
    { cell_type: "markdown", id: "m1", metadata: {}, source: ["# Title"] },
    { cell_type: "code", id: "c1", metadata: {}, execution_count: 3, source: ["x = 1\n", "print(x)"], outputs: [{ output_type: "stream", name: "stdout", text: ["1\n"] }] },
    { cell_type: "code", id: "c2", metadata: {}, execution_count: 4, source: ["y = 2"], outputs: [{ output_type: "stream", name: "stdout", text: ["kept\n"] }] },
  ],
  metadata: { kernelspec: { name: "python3" } }, nbformat: 4, nbformat_minor: 5,
}, null, 1) + "\n";

async function book() {
  const d = workdir(), f = join(d, "a.ipynb"), c = conversation(d);
  writeFileSync(f, notebook());
  await read.run({ file_path: f }, c);
  const cells = (): { cell_type: string; id?: string; source: string[]; outputs?: unknown[]; execution_count?: number | null }[] => JSON.parse(readFileSync(f, "utf8")).cells;
  return { d, f, c, cells };
}

describe("NotebookEdit", () => {
  test("replaces a cell by id: its source changes and its saved outputs are cleared, the others keep theirs", async () => {
    const { f, c, cells } = await book();
    expect(await nb.run({ file_path: f, cell_id: "c1", new_source: "x = 5\nprint(x)" }, c)).toBe(`Replaced cell 1 of ${f}.`);
    expect(cells()[1]).toMatchObject({ id: "c1", source: ["x = 5\n", "print(x)"], outputs: [], execution_count: null });
    expect(cells()[2]!.outputs).toHaveLength(1);
    expect(cells()[2]!.execution_count).toBe(4);
  });
  test("a cell is named by its number as Read shows it, and the file keeps its indentation and its other keys", async () => {
    const { f, c, cells } = await book();
    await nb.run({ file_path: f, cell_id: "2", new_source: "y = 3" }, c);
    expect(cells()[2]!.source).toEqual(["y = 3"]);
    const text = readFileSync(f, "utf8");
    expect(text.startsWith('{\n "cells"')).toBe(true);
    expect(text).toContain('"kernelspec"');
    expect(text.endsWith("}\n")).toBe(true);
  });
  test("inserts after a cell, or first when none is named, and gives the new cell an id", async () => {
    const { f, c, cells } = await book();
    await nb.run({ file_path: f, cell_id: "c1", new_source: "z = 0", edit_mode: "insert", cell_type: "code" }, c);
    expect(cells().map((x) => x.source.join(""))).toEqual(["# Title", "x = 1\nprint(x)", "z = 0", "y = 2"]);
    expect(cells()[2]!.id).toMatch(/^[0-9a-f]{8}$/);
    await nb.run({ file_path: f, new_source: "intro", edit_mode: "insert", cell_type: "markdown" }, c);
    expect(cells()[0]).toMatchObject({ cell_type: "markdown", source: ["intro"] });
    expect(cells()[0]!.outputs).toBeUndefined();
  });
  test("deletes a cell", async () => {
    const { f, c, cells } = await book();
    expect(await nb.run({ file_path: f, cell_id: "m1", edit_mode: "delete" }, c)).toMatch(/^Deleted cell 0/);
    expect(cells().map((x) => x.id)).toEqual(["c1", "c2"]);
  });
  test("says what is wrong: an unknown cell, a missing id, a bad mode, a file that is not a notebook", async () => {
    const { d, f, c } = await book();
    expect(await nb.run({ file_path: f, cell_id: "nope", new_source: "x" }, c)).toMatch(/no cell "nope".*3 cells \(numbers 0 to 2/);
    expect(await nb.run({ file_path: f, new_source: "x" }, c)).toMatch(/replace needs cell_id/);
    expect(await nb.run({ file_path: f, cell_id: "c1", edit_mode: "move" }, c)).toMatch(/edit_mode must be one of/);
    writeFileSync(join(d, "bad.ipynb"), "{ not json");
    await read.run({ file_path: join(d, "bad.ipynb") }, c);
    expect(await nb.run({ file_path: join(d, "bad.ipynb"), cell_id: "0", new_source: "x" }, c)).toMatch(/not a valid notebook/);
  });
  test("another program's name for the path is understood, and it is offered when the request is about a notebook", () => {
    expect(nb.fixArgs!({ notebook_path: "a.ipynb", cell_id: "c1" })).toEqual({ notebook_path: "a.ipynb", cell_id: "c1", file_path: "a.ipynb" });
    const s = { small: true, jobs: 0 };
    expect(nb.offeredWhen!({ ...s, userText: "fix the bug in src/a.ts" })).toBe(false);
    expect(nb.offeredWhen!({ ...s, userText: "change the plot in analysis.ipynb" })).toBe(true);
  });
});

describe("the patch format", () => {
  test("parses add, delete, update with a move, context lines and the end of file marker", () => {
    const h = parsePatch("*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Delete File: b.txt\n*** Update File: c.txt\n*** Move to: d.txt\n@@ fn main\n keep\n-old\n+new\n*** End of File\n*** End Patch");
    expect(h).toEqual([
      { op: "add", path: "a.txt", text: "one\ntwo\n" },
      { op: "delete", path: "b.txt" },
      { op: "update", path: "c.txt", moveTo: "d.txt", chunks: [{ context: "fn main", eof: true, lines: [{ k: " ", t: "keep" }, { k: "-", t: "old" }, { k: "+", t: "new" }] }] },
    ]);
    expect(patchPaths("*** Begin Patch\n*** Update File: c.txt\n*** Move to: d.txt\n@@\n-a\n+b\n*** Add File: e.txt\n+x\n*** End Patch")).toEqual(["c.txt", "d.txt", "e.txt"]);
  });
  test("a patch in a shell heredoc is taken as it is", () => {
    expect(parsePatch("<<'EOF'\n*** Begin Patch\n*** Delete File: a\n*** End Patch\nEOF")).toEqual([{ op: "delete", path: "a" }]);
  });
  test("says what is wrong with a patch that is not one", () => {
    expect(parsePatch("hello")).toMatch(/first line must be "\*\*\* Begin Patch"/);
    expect(parsePatch("*** Begin Patch\n*** Add File: a\n+x")).toMatch(/last line must be/);
    expect(parsePatch("*** Begin Patch\n*** Rename File: a\n*** End Patch")).toMatch(/unexpected line/);
    expect(parsePatch("*** Begin Patch\n*** Update File: a\n@@\nbad\n*** End Patch")).toMatch(/unexpected line in the changes to a/);
    expect(parsePatch("*** Begin Patch\n*** End Patch")).toMatch(/changes no file/);
  });
  test("seek tries the text as written, then without trailing spaces, then without indentation, then with plain punctuation", () => {
    const lines = ["alpha", "  beta  ", "\tgamma", "say “hi” – ok"];
    expect(seek(lines, ["alpha"], 0, false)).toBe(0);
    expect(seek(lines, ["  beta"], 0, false)).toBe(1);
    expect(seek(lines, ["gamma"], 0, false)).toBe(2);
    expect(seek(lines, ['say "hi" - ok'], 0, false)).toBe(3);
    expect(seek(lines, ["alpha"], 1, false)).toBeUndefined();
    expect(seek(["a", "b", "a", "b"], ["a", "b"], 0, true)).toBe(2);
  });
});

describe("apply_patch", () => {
  const make = (files: Record<string, string>) => { const d = workdir(); for (const [n, t] of Object.entries(files)) { mkdirSync(join(d, n, ".."), { recursive: true }); writeFileSync(join(d, n), t); } return d; };

  test("changes several files at once: adds, deletes, updates and moves, and lists them", async () => {
    const d = make({ "src/a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n", "old.txt": "bye\n", "m.txt": "x\ny\n" });
    const out = await patch.run({ patch: [
      "*** Begin Patch", "*** Update File: src/a.ts", "@@ const a = 1;", "-const b = 2;", "+const b = 20;", " const c = 3;", "+const d = 4;",
      "*** Add File: new/n.txt", "+hello", "*** Delete File: old.txt", "*** Update File: m.txt", "*** Move to: moved/m2.txt", "@@", " x", "-y", "+Y", "*** End Patch"].join("\n") }, conversation(d));
    expect(out).toBe(`Success. Updated the following files:\nM ${join(d, "src/a.ts")}\nA ${join(d, "new/n.txt")}\nD ${join(d, "old.txt")}\nM ${join(d, "moved/m2.txt")}`);
    expect(readFileSync(join(d, "src/a.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n");
    expect(readFileSync(join(d, "new/n.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(d, "old.txt"))).toBe(false);
    expect(existsSync(join(d, "m.txt"))).toBe(false);
    expect(readFileSync(join(d, "moved/m2.txt"), "utf8")).toBe("x\nY\n");
  });
  test("all or nothing: when the second file does not match, the first is not changed, and the line that failed is named", async () => {
    const d = make({ "a.txt": "one\ntwo\n", "b.txt": "red\ngreen\n" });
    const out = await patch.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+1\n*** Update File: b.txt\n@@\n-blue\n+BLUE\n*** End Patch" }, conversation(d));
    expect(out).toBe("Error: Failed to find the expected lines in b.txt:\nblue Nothing was changed. Read the file again and copy the lines exactly.");
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });
  test("a context line that is not in the file is named", async () => {
    const d = make({ "a.txt": "one\n" });
    const out = await patch.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@ def missing():\n-one\n+1\n*** End Patch" }, conversation(d));
    expect(out).toMatch(/^Error: Failed to find context 'def missing\(\):' in a\.txt\. Nothing was changed/);
  });
  test("a write that fails half way puts the earlier files back", async () => {
    // A name that is a file where a folder is needed: the second file cannot be made on any system, whoever is running the test.
    const d = make({ "a.txt": "one\n", blocker: "not a folder\n" });
    const out = await patch.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+1\n*** Add File: blocker/b.txt\n+x\n*** End Patch" }, conversation(d));
    expect(out).toMatch(/could not be written.*put back/);
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\n");
    expect(readdirSync(d).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  test("matches ignoring indentation and keeps the lines that stay as the file has them; CRLF files stay CRLF", async () => {
    const d = make({ "a.txt": "\tfoo();\r\n\tbar();\r\n" });
    await patch.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n foo();\n-bar();\n+baz();\n*** End Patch" }, conversation(d));
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("\tfoo();\r\nbaz();\r\n");
  });
  test("a file that is not there cannot be updated or deleted, and nothing is done", async () => {
    const d = make({ "a.txt": "one\n" });
    expect(await patch.run({ patch: "*** Begin Patch\n*** Update File: no.txt\n@@\n-a\n+b\n*** End Patch" }, conversation(d))).toMatch(/no\.txt does not exist.*use "\*\*\* Add File:"/);
    expect(await patch.run({ patch: "*** Begin Patch\n*** Delete File: no.txt\n*** End Patch" }, conversation(d))).toMatch(/cannot be deleted/);
  });
  test("a path outside a confined conversation is refused before anything changes", async () => {
    const d = make({ "a.txt": "one\n" });
    const out = await patch.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+1\n*** Add File: /tmp/elsewhere-navvied.txt\n+x\n*** End Patch" }, conversation(d, { root: d }));
    expect(out).toMatch(/outside the folder this conversation may use.*Nothing was changed/);
    expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one\n");
  });
  test("what it wrote is known to the conversation: the next Edit needs no read", async () => {
    const d = workdir(), c = conversation(d);
    await patch.run({ patch: "*** Begin Patch\n*** Add File: n.txt\n+a\n*** End Patch" }, c);
    expect(await tool("Edit").run({ file_path: join(d, "n.txt"), old_string: "a", new_string: "b" }, c)).toMatch(/^Edited/);
  });
  test("the argument another program calls input is understood; it is offered by the switch in the configuration", () => {
    expect(patch.fixArgs!({ input: "x" })).toEqual({ patch: "x" });
    const s = { userText: "", jobs: 0 };
    expect(tool("apply_patch", "auto").offeredWhen!({ ...s, small: true, steps: 2 })).toBe(false);
    expect(tool("apply_patch", "auto").offeredWhen!({ ...s, small: false, steps: 0 })).toBe(false);
    expect(tool("apply_patch", "auto").offeredWhen!({ ...s, small: false, steps: 2 })).toBe(true);
    expect(tool("apply_patch", "on").offeredWhen!({ ...s, small: true })).toBe(true);
    expect(() => tool("apply_patch", "off")).toThrow(/no tool/);
  });
});
