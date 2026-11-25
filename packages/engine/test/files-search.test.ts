import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOOK_MS, hook } from "../../protocol/test/support/cleanup.ts";
import { cleanFiles, conversation, tool, workdir } from "./files-support.ts";

afterAll(hook("files-search removes what it made", cleanFiles), HOOK_MS);
const glob = tool("Glob"), grep = tool("Grep");
const git = Bun.which("git"), rg = Bun.which("rg");

/** Runs `body` with the search programs this computer has replaced by exactly the ones named. */
async function only<T>(programs: string[], body: () => Promise<T>): Promise<T> {
  const bin = workdir();
  const wanted = programs.map((p) => Bun.which(p)).filter((p): p is string => !!p);
  // A program on Windows needs the files next to it, so it is not linked into a folder of its own: the folders it lives in stand for it.
  if (process.platform !== "win32") for (const at of wanted) symlinkSync(at, join(bin, basename(at)));
  const before = process.env.PATH;
  process.env.PATH = process.platform === "win32" ? [...new Set(wanted.map((at) => dirname(at)))].join(";") : bin;
  try { return await body(); } finally { process.env.PATH = before; }
}

function project(): string {
  const d = workdir();
  if (git) Bun.spawnSync(["git", "init", "-q"], { cwd: d });
  mkdirSync(join(d, "src")); mkdirSync(join(d, "dist")); mkdirSync(join(d, ".github"));
  writeFileSync(join(d, ".gitignore"), "dist/\n*.log\n");
  writeFileSync(join(d, "src/a.ts"), "const needle = 1;\n");
  writeFileSync(join(d, "dist/a.js"), "needle\n");
  writeFileSync(join(d, "x.log"), "needle\n");
  writeFileSync(join(d, ".github/ci.yml"), "needle: true\n");
  return d;
}

describe("Glob", () => {
  for (const [way, programs] of [["without ripgrep, with git", ["git"]], ["with ripgrep", ["rg", "git"]]] as const) {
    test.skipIf((way === "with ripgrep" && !rg) || (programs.includes("git") && !git))(`${way}: leaves out what .gitignore names and dot files, and takes dot files with hidden`, async () => {
      const d = project();
      const out = await only([...programs], () => glob.run({ pattern: "**/*" }, conversation(d)));
      expect(out).toBe("src/a.ts");
      const all = await only([...programs], () => glob.run({ pattern: "**/*", hidden: true }, conversation(d)));
      expect(all).toContain(".github/ci.yml");
      expect(all).toContain(".gitignore");
      expect(all).not.toContain("dist/a.js");
    });
  }
  test("with neither program there is no .gitignore to read: node_modules and .git are still left out", async () => {
    const d = workdir();
    mkdirSync(join(d, "node_modules")); mkdirSync(join(d, ".git")); mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "node_modules/x.ts"), "1"); writeFileSync(join(d, ".git/y.ts"), "1"); writeFileSync(join(d, "dist/z.ts"), "1"); writeFileSync(join(d, "k.ts"), "1");
    expect((await only([], () => glob.run({ pattern: "**/*.ts", hidden: true }, conversation(d)))).split("\n").sort()).toEqual(["dist/z.ts", "k.ts"]);
  });
  test("a pattern that names a dot folder finds it without hidden", async () => {
    const d = project();
    expect(await glob.run({ pattern: ".github/*.yml" }, conversation(d))).toBe(".github/ci.yml");
  });
  test("every file is looked at before the newest 100 are chosen, so a file past the first 2,000 found is not lost", async () => {
    const d = workdir();
    mkdirSync(join(d, "many"));
    for (let i = 0; i < 2100; i++) { const f = join(d, "many", `f${String(i).padStart(4, "0")}.txt`); writeFileSync(f, "x"); utimesSync(f, new Date(1_000_000_000_000 + i * 1000), new Date(1_000_000_000_000 + i * 1000)); }
    const out = await glob.run({ pattern: "many/*.txt" }, conversation(d));
    const lines = out.split("\n");
    expect(lines[0]).toBe("many/f2099.txt");
    expect(lines[99]).toBe("many/f2000.txt");
    expect(lines.at(-1)).toMatch(/\[2100 files, 100 shown/);
  });
  test("an empty pattern and a pattern that matches nothing are said", async () => {
    const d = project();
    expect(await glob.run({ pattern: "" }, conversation(d))).toMatch(/empty pattern/);
    expect(await glob.run({ pattern: "**/*.rs" }, conversation(d))).toBe("No files matched.");
  });
});

const ways: [string, string[]][] = [["done in the program itself", ["git"]], ["with ripgrep", ["rg"]]];
describe("Grep", () => {
  for (const [way, programs] of ways) {
    const skip = (programs.includes("rg") && !rg) || (programs.includes("git") && !git);
    const run = (d: string, a: Record<string, unknown>): Promise<string> => only(programs, () => grep.run(a, conversation(d))).then((o) => o.replace(/\n\[searched without ripgrep:[^\]]*\]$/, ""));
    const lines = (): string => Array.from({ length: 12 }, (_, i) => (i === 5 ? "needle five" : i === 6 ? "needle six" : i === 10 ? "needle ten" : `line ${i + 1}`)).join("\n") + "\n";

    describe.skipIf(skip)(way, () => {
      test("follows .gitignore and looks at dot files; node_modules and .git are left out", async () => {
        const d = project();
        mkdirSync(join(d, "node_modules")); writeFileSync(join(d, "node_modules/n.js"), "needle\n");
        expect(await run(d, { pattern: "needle" })).toBe(`.github/ci.yml:1:needle: true\nsrc/a.ts:1:const needle = 1;`);
      });
      test("context lines before and after, with a separator between groups, as -A, -B, -C or context", async () => {
        const d = workdir();
        writeFileSync(join(d, "f.txt"), lines());
        expect(await run(d, { pattern: "five", context: 1 })).toBe("f.txt-5-line 5\nf.txt:6:needle five\nf.txt-7-needle six");
        expect(await run(d, { pattern: "five|ten", after: 1 })).toBe("f.txt:6:needle five\nf.txt-7-needle six\n--\nf.txt:11:needle ten\nf.txt-12-line 12");
        const aliased = grep.fixArgs!({ pattern: "five", "-B": 1, "-i": true, head_limit: 3 });
        expect(aliased).toEqual({ pattern: "five", before: 1, ignore_case: true, limit: 3 });
        expect(await run(d, aliased)).toBe("f.txt-5-line 5\nf.txt:6:needle five");
      });
      test("output modes: files_with_matches lists files, count gives matching lines per file and a total", async () => {
        const d = workdir();
        writeFileSync(join(d, "a.txt"), "needle\nneedle\nx\n"); writeFileSync(join(d, "b.txt"), "needle\n"); writeFileSync(join(d, "c.txt"), "none\n");
        expect((await run(d, { pattern: "needle", output_mode: "files_with_matches" })).split("\n").sort()).toEqual(["a.txt", "b.txt"]);
        expect(await run(d, { pattern: "needle", output_mode: "count" })).toBe("a.txt:2\nb.txt:1\n[3 matching lines in 2 files]");
      });
      test("multiline matches across lines; without it a pattern stays within one line", async () => {
        const d = workdir();
        writeFileSync(join(d, "f.txt"), "start\nmiddle\nend\n");
        expect(await run(d, { pattern: "start.*end" })).toBe("No matches.");
        expect(await run(d, { pattern: "start.*end", multiline: true })).toBe("f.txt:1:start\nf.txt:2:middle\nf.txt:3:end");
      });
      test("type narrows to a language, glob to a pattern; an unknown type is an error", async () => {
        const d = workdir();
        writeFileSync(join(d, "a.ts"), "needle\n"); writeFileSync(join(d, "b.py"), "needle\n"); writeFileSync(join(d, "c.md"), "needle\n");
        expect(await run(d, { pattern: "needle", type: "py" })).toBe("b.py:1:needle");
        expect(await run(d, { pattern: "needle", glob: "*.md" })).toBe("c.md:1:needle");
        expect(await run(d, { pattern: "needle", type: "nonsense" })).toStartWith("Error:");
      });
      test("limit and offset page through the matches, and the message says where to go on", async () => {
        const d = workdir();
        writeFileSync(join(d, "f.txt"), Array.from({ length: 10 }, (_, i) => `hit ${i + 1}`).join("\n"));
        expect(await run(d, { pattern: "hit", limit: 3 })).toBe("f.txt:1:hit 1\nf.txt:2:hit 2\nf.txt:3:hit 3\n[7 more matches were not shown: narrow the pattern, add a glob, search one file, or continue with offset 3]");
        expect(await run(d, { pattern: "hit", limit: 3, offset: 8 })).toBe("f.txt:9:hit 9\nf.txt:10:hit 10");
      });
      test("a pattern the program refuses is an error, and nothing found is said", async () => {
        const d = workdir();
        writeFileSync(join(d, "f.txt"), "x\n");
        expect(await run(d, { pattern: "(" })).toStartWith("Error:");
        expect(await run(d, { pattern: "zzz" })).toBe("No matches.");
        expect(await run(d, { pattern: "x", path: "missing" })).toMatch(/does not exist/);
      });
    });
  }
  test.skipIf(!rg)("ripgrep gives the same lines as the search done in the program itself", async () => {
    const d = project();
    writeFileSync(join(d, "src/b.ts"), "a\nneedle two\nb\nneedle three\n");
    const args = { pattern: "needle", context: 1 };
    const a = await only(["rg"], () => grep.run(args, conversation(d)));
    const b = (await only(["git"], () => grep.run(args, conversation(d)))).replace(/\n\[searched without ripgrep:[^\]]*\]$/, "");
    expect(b).toBe(a);
  });
  test("the search done in the program itself says its patterns are JavaScript's, ripgrep's result does not", async () => {
    const d = workdir();
    writeFileSync(join(d, "f.txt"), "x\n");
    expect(await only([], () => grep.run({ pattern: "x" }, conversation(d)))).toContain("[searched without ripgrep: patterns follow JavaScript's rules");
  });
  // The stand-in for ripgrep is a shell script, which Windows cannot run; what is checked is the list of options, the same on every system.
  test.skipIf(process.platform === "win32")("the options are passed to ripgrep as it takes them", async () => {
    const d = workdir(), bin = workdir();
    writeFileSync(join(bin, "rg"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(d, "argv")}\necho "f.txt:1:x"\n`);
    require("node:fs").chmodSync(join(bin, "rg"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = bin;
    try { expect(await grep.run({ pattern: "x.y", ignore_case: true, multiline: true, type: "ts", glob: "*.ts", context: 2 }, conversation(d))).toBe("f.txt:1:x"); } finally { process.env.PATH = before; }
    const argv = (await Bun.file(join(d, "argv")).text()).trim().split("\n");
    expect(argv).toEqual(["--no-messages", "--color", "never", "--hidden", "-g", "!.git", "-g", "!node_modules", "-nH", "--no-heading", "--sort", "path", "--max-columns", "300", "-B", "2", "-A", "2", "-i", "-U", "--multiline-dotall", "-g", "*.ts", "-t", "ts", "-e", "x.y", "."]);
  });
});
