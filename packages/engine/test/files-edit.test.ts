import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";
import { applyChange } from "../src/tools/edit-text.ts";
import { cleanFiles, conversation, tool, workdir } from "./files-support.ts";

afterAll(hook("files-edit removes what it made", cleanFiles), HOOK_MS);
const edit = tool("Edit"), multi = tool("MultiEdit"), write = tool("Write"), read = tool("Read");

/** A file in a conversation that has read it. */
async function known(text: string | Buffer, name = "f.txt") {
  const d = workdir(), f = join(d, name), c = conversation(d);
  writeFileSync(f, text);
  await read.run({ file_path: f }, c);
  return { d, f, c };
}

describe("a file that was not read", () => {
  test("Edit refuses with the call to make, and works after a Read", async () => {
    const d = workdir(), f = join(d, "f.txt"), c = conversation(d);
    writeFileSync(f, "one\n");
    const refused = await edit.run({ file_path: f, old_string: "one", new_string: "1" }, c);
    expect(refused).toBe(`Error: ${f} was not read in this conversation. Read it first: Read {"file_path": ${JSON.stringify(f)}}, then send this call again.`);
    expect(readFileSync(f, "utf8")).toBe("one\n");
    await read.run({ file_path: f }, c);
    expect(await edit.run({ file_path: f, old_string: "one", new_string: "1" }, c)).toMatch(/^Edited/);
  });
  test("Write refuses to replace it, MultiEdit and NotebookEdit too; a new file or an empty one needs no read", async () => {
    const d = workdir(), f = join(d, "f.txt"), c = conversation(d);
    writeFileSync(f, "keep me\n");
    writeFileSync(join(d, "empty.txt"), "");
    expect(await write.run({ file_path: f, content: "x" }, c)).toMatch(/exists and was not read.*Write would replace all of it.*Read it first/);
    expect(await multi.run({ file_path: f, edits: [{ old_string: "keep", new_string: "lose" }] }, c)).toMatch(/was not read/);
    expect(await tool("NotebookEdit").run({ file_path: f, new_source: "x" }, c)).toMatch(/was not read/);
    expect(readFileSync(f, "utf8")).toBe("keep me\n");
    expect(await write.run({ file_path: join(d, "new.txt"), content: "x" }, c)).toMatch(/^Created/);
    expect(await write.run({ file_path: join(d, "empty.txt"), content: "x" }, c)).toMatch(/^Overwrote/);
  });
  test("what a conversation wrote itself it knows: the next edit needs no read", async () => {
    const d = workdir(), c = conversation(d), f = join(d, "n.txt");
    await write.run({ file_path: f, content: "a\nb\n" }, c);
    expect(await edit.run({ file_path: f, old_string: "b", new_string: "B" }, c)).toMatch(/^Edited/);
    expect(await edit.run({ file_path: f, old_string: "a", new_string: "A" }, c)).toMatch(/^Edited/);
  });
  test("each conversation has its own record", async () => {
    const { d, f } = await known("one\n");
    expect(await edit.run({ file_path: f, old_string: "one", new_string: "1" }, conversation(d))).toMatch(/was not read/);
  });
});

describe("a file that changed after it was read", () => {
  const change = (f: string, text: string): void => { writeFileSync(f, text); utimesSync(f, new Date(), new Date(Date.now() + 5000)); };
  test("an edit whose text is still there, once, goes through, and says the file had changed", async () => {
    const { f, c } = await known("a\nb\nc\n");
    change(f, "a\nb\nc\nd\n");
    const out = await edit.run({ file_path: f, old_string: "b", new_string: "B" }, c);
    expect(out).toMatch(/^Edited/);
    expect(out).toContain("the file had changed since you read it");
    expect(readFileSync(f, "utf8")).toBe("a\nB\nc\nd\n");
  });
  test("an edit whose text is gone is refused with the call to read again, and the file is not touched", async () => {
    const { f, c } = await known("a\nb\nc\n");
    change(f, "a\nX\nc\n");
    const out = await edit.run({ file_path: f, old_string: "b", new_string: "B" }, c);
    expect(out).toBe(`Error: ${f} changed after you read it (something else wrote to it). Read it first: Read {"file_path": ${JSON.stringify(f)}}, then send this call again.`);
    expect(readFileSync(f, "utf8")).toBe("a\nX\nc\n");
    await read.run({ file_path: f }, c);
    expect(await edit.run({ file_path: f, old_string: "X", new_string: "B" }, c)).toMatch(/^Edited/);
  });
  test("a changed file is not matched by a fuzzy way: only exactly", async () => {
    const { f, c } = await known("    a\n");
    change(f, "    a\nmore\n");
    expect(await edit.run({ file_path: f, old_string: "a", new_string: "b" }, c)).toMatch(/^Edited/);
    change(f, "    a\nmore\nand more\n");
    expect(await edit.run({ file_path: f, old_string: "\ta\nmore", new_string: "b" }, c)).toMatch(/changed after you read it/);
  });
  test("Write refuses to replace it", async () => {
    const { f, c } = await known("a\n");
    change(f, "b\n");
    expect(await write.run({ file_path: f, content: "c" }, c)).toMatch(/changed after you read it/);
    expect(readFileSync(f, "utf8")).toBe("b\n");
  });
});

describe("Edit finds what the model meant, in a safe order", () => {
  test("exact first: nothing is said", async () => {
    const { f, c } = await known("a\n  b\n");
    const out = await edit.run({ file_path: f, old_string: "  b", new_string: "  B" }, c);
    expect(out).not.toContain("Note");
  });
  test("the same lines with other indentation match, the new text takes the file's indentation, and a note says so", async () => {
    const { f, c } = await known("function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n");
    const out = await edit.run({ file_path: f, old_string: "  if (x) {\n    return 1;\n  }", new_string: "  if (y) {\n    return 2;\n  }" }, c);
    expect(out).toContain("Note: matched the lines ignoring differences in indentation");
    expect(readFileSync(f, "utf8")).toBe("function f() {\n\tif (y) {\n\t\treturn 2;\n\t}\n}\n");
  });
  test("plain quotes and dashes match typographic ones, and a note says so", async () => {
    const { f, c } = await known("say “hello” – done\n");
    const out = await edit.run({ file_path: f, old_string: 'say "hello" - done', new_string: "say bye" }, c);
    expect(out).toContain("plain quotes and dashes");
    expect(readFileSync(f, "utf8")).toBe("say bye\n");
  });
  test("a copied line-number gutter is left out", async () => {
    const { f, c } = await known("one\ntwo\n");
    const out = await edit.run({ file_path: f, old_string: "     1\tone\n     2\ttwo", new_string: "     1\tuno\n     2\tdos" }, c);
    expect(out).toContain("line numbers");
    expect(readFileSync(f, "utf8")).toBe("uno\ndos\n");
  });
  test("two places that match only loosely are refused, naming the lines, and replace_all takes both", async () => {
    const { f, c } = await known("  x = 1\nmid\n    x = 1\n");
    expect(await edit.run({ file_path: f, old_string: "x = 1", new_string: "x = 2" }, c)).toMatch(/matches 2 places \(lines 1, 3\)/);
    expect(await edit.run({ file_path: f, old_string: "x = 1", new_string: "x = 2", replace_all: true }, c)).toMatch(/2 replacements/);
  });
  test("applyChange: a text that is not there says to read again", () => {
    expect(applyChange("a\n", { from: "zz", to: "y", all: false })).toEqual({ error: "old_string was not found. Read the file again and copy the text exactly, including whitespace." });
  });
});

describe("what Edit gives back and keeps", () => {
  test("a few numbered lines of the result", async () => {
    const { f, c } = await known(Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const out = await edit.run({ file_path: f, old_string: "l10", new_string: "ten\nten and a half" }, c);
    expect(out).toContain("Edited");
    expect(out).toContain("     8\tl8\n     9\tl9\n    10\tten\n    11\tten and a half\n    12\tl11");
    expect(out).not.toContain("l1\n");
  });
  test("a byte-order mark, CRLF lines and the rights of the file stay", async () => {
    const { f, c } = await known(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]));
    chmodSync(f, 0o750);
    await edit.run({ file_path: f, old_string: "a\nb", new_string: "x\ny" }, c);
    expect([...readFileSync(f)]).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("x\r\ny\r\n")]);
    // Windows has no execute bit to keep: its files are 0o666 or 0o444.
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o750);
  });
  test("a UTF-16 file stays UTF-16", async () => {
    const { f, c } = await known(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\n", "utf16le")]));
    await edit.run({ file_path: f, old_string: "héllo", new_string: "hola" }, c);
    expect([...readFileSync(f)]).toEqual([0xff, 0xfe, ...Buffer.from("hola\n", "utf16le")]);
  });
  test("a file that is not valid UTF-8 is not touched", async () => {
    const { f, c } = await known(Buffer.from([0x61, 0xe9, 0x62]));
    expect(await edit.run({ file_path: f, old_string: "a", new_string: "b" }, c)).toMatch(/not valid UTF-8/);
    expect([...readFileSync(f)]).toEqual([0x61, 0xe9, 0x62]);
  });
  test("the write is made beside the file and renamed: no temporary file is left, and a link is followed", async () => {
    const { d, f, c } = await known("a\n");
    symlinkSync(f, join(d, "link.txt"));
    await read.run({ file_path: join(d, "link.txt") }, c);
    await edit.run({ file_path: join(d, "link.txt"), old_string: "a", new_string: "b" }, c);
    expect(readFileSync(f, "utf8")).toBe("b\n");
    expect(statSync(join(d, "link.txt")).isFile()).toBe(true);
    expect(readdirSync(d).sort()).toEqual(["f.txt", "link.txt"]);
  });
});

describe("MultiEdit", () => {
  test("makes its edits in order, each on what the one before left", async () => {
    const { f, c } = await known("let a = 1;\nlet b = 2;\n");
    const out = await multi.run({ file_path: f, edits: [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "a = 10;\nlet b", new_string: "a = 10;\nconst b" }, { old_string: "= ", new_string: ":= ", replace_all: true }] }, c);
    expect(out).toMatch(/^Edited .*: 3 changes \(line 1, line 1, line 1\), 4 replacements\./);
    expect(readFileSync(f, "utf8")).toBe("let a := 10;\nconst b := 2;\n");
  });
  test("if one fails, none is made, and the message says which", async () => {
    const { f, c } = await known("a\nb\n");
    const out = await multi.run({ file_path: f, edits: [{ old_string: "a", new_string: "A" }, { old_string: "zzz", new_string: "Z" }] }, c);
    expect(out).toBe("Error: change 2 of 2: old_string was not found. Read the file again and copy the text exactly, including whitespace. Nothing was changed.");
    expect(readFileSync(f, "utf8")).toBe("a\nb\n");
  });
  test("an empty list is explained", async () => {
    const { f, c } = await known("a\n");
    expect(await multi.run({ file_path: f, edits: [] }, c)).toMatch(/edits must be a list/);
  });
  test("is offered to a model with a large window after the first step of a turn, so that the first request stays light", () => {
    const s = { jobs: 0, userText: "" };
    expect(multi.offeredWhen!({ ...s, small: true, steps: 3 })).toBe(false);
    expect(multi.offeredWhen!({ ...s, small: false, steps: 0 })).toBe(false);
    expect(multi.offeredWhen!({ ...s, small: false, steps: 1 })).toBe(true);
  });
});

describe("Write", () => {
  test("keeps the line ends and the mark of the file it replaces", async () => {
    const { f, c } = await known(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]));
    await write.run({ file_path: f, content: "x\ny\nz\n" }, c);
    expect([...readFileSync(f)]).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("x\r\ny\r\nz\r\n")]);
    await write.run({ file_path: f, content: "p\r\nq\r\n" }, c);
    expect(readFileSync(f, "utf8")).toBe("﻿p\r\nq\r\n");
  });
  test("a file of plain lines stays plain, and the file is written whole or not at all", async () => {
    const { d, f, c } = await known("a\nb\n");
    await write.run({ file_path: f, content: "x\ny\n" }, c);
    expect(readFileSync(f, "utf8")).toBe("x\ny\n");
    expect(readdirSync(d)).toEqual(["f.txt"]);
    expect(existsSync(join(d, "deep"))).toBe(false);
    expect(await write.run({ file_path: join(d, "deep/er.txt"), content: "1" }, c)).toMatch(/^Created/);
  });
  test("a folder is not written", async () => {
    const d = workdir();
    expect(await write.run({ file_path: d, content: "x" }, conversation(d))).toMatch(/is a directory/);
  });
});
