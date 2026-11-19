import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { Jobs, defaultTools, isPrivateHost } from "../src/index.ts";
import { clip, run } from "../src/tools/util.ts";
import type { Tool, ToolContext } from "../src/types.ts";

const dirs: string[] = [];
const workdir = () => { const d = mkdtempSync(join(tmpdir(), "navvied-tools-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const tool = (name: string): Tool => { const t = defaultTools().find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); return t; };
const ctx = (cwd: string, extra: Partial<ToolContext> = {}): ToolContext & { emitted: EngineEvent[] } => {
  const emitted: EngineEvent[] = [];
  return { cwd, signal: new AbortController().signal, emit: (e) => emitted.push(e), allowPrivateNetwork: false, jobs: new Jobs((e) => emitted.push(e)), ...extra, emitted };
};

describe("a command that is stopped", () => {
  test("is reported soon even when a child it started keeps the output open", async () => {
    const script = `const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { detached: true, stdio: "inherit" }); setTimeout(() => {}, 30000);`;
    const started = Date.now();
    const r = await run([process.execPath, "-e", script], { cwd: tmpdir(), signal: new AbortController().signal, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("the tool set", () => {
  test("names, schemas and read-only flags", () => {
    const all = defaultTools();
    expect(all.map((t) => t.name)).toEqual(["Read", "Write", "Edit", "Bash", "BashOutput", "BashInput", "KillShell", "Glob", "Grep", "WebFetch", "WebSearch", "Browser", "Skill", "Agent", "Remember", "Recall", "TodoWrite"]);
    expect(all.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["Read", "BashOutput", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", "Agent", "Recall", "TodoWrite"]);
    for (const t of all) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters).toMatchObject({ type: "object" });
      expect(typeof t.title({})).toBe("string");
    }
  });
});

describe("Read", () => {
  test("numbers lines, honours offset and limit, and says how to continue", async () => {
    const d = workdir();
    writeFileSync(join(d, "a.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const out = await tool("Read").run({ file_path: "a.txt", offset: 3, limit: 2 }, ctx(d));
    expect(out).toContain("     3\tline3");
    expect(out).toContain("     4\tline4");
    expect(out).not.toContain("line5");
    expect(out).toMatch(/6 more lines — raise offset/);
  });
  test("refuses directories, binaries, missing and oversized files with a useful message", async () => {
    const d = workdir();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "bin"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(d, "big.txt"), "x".repeat(5_000_001));
    const r = tool("Read");
    expect(await r.run({ file_path: "sub" }, ctx(d))).toMatch(/is a directory/);
    expect(await r.run({ file_path: "bin" }, ctx(d))).toMatch(/looks binary/);
    expect(await r.run({ file_path: "nope" }, ctx(d))).toMatch(/does not exist/);
    expect(await r.run({ file_path: "big.txt" }, ctx(d))).toMatch(/too large/);
  });
});

describe("Write and Edit", () => {
  test("Write creates parent directories and reports create vs overwrite", async () => {
    const d = workdir();
    const w = tool("Write");
    expect(await w.run({ file_path: "deep/er/f.txt", content: "a\nb" }, ctx(d))).toMatch(/Created .*f\.txt \(2 lines\)/);
    expect(await w.run({ file_path: "deep/er/f.txt", content: "c" }, ctx(d))).toMatch(/Overwrote/);
    expect(readFileSync(join(d, "deep/er/f.txt"), "utf8")).toBe("c");
  });
  test("Edit: unique match, replace_all, not found, ambiguous, identical, empty, missing file", async () => {
    const d = workdir();
    const f = join(d, "f.txt");
    const e = tool("Edit");
    writeFileSync(f, "one two one\n");
    expect(await e.run({ file_path: f, old_string: "two", new_string: "2" }, ctx(d))).toMatch(/1 replacement\)/);
    expect(readFileSync(f, "utf8")).toBe("one 2 one\n");
    expect(await e.run({ file_path: f, old_string: "one", new_string: "1" }, ctx(d))).toMatch(/matches 2 places/);
    expect(await e.run({ file_path: f, old_string: "one", new_string: "1", replace_all: true }, ctx(d))).toMatch(/2 replacements/);
    expect(readFileSync(f, "utf8")).toBe("1 2 1\n");
    expect(await e.run({ file_path: f, old_string: "zzz", new_string: "y" }, ctx(d))).toMatch(/was not found/);
    expect(await e.run({ file_path: f, old_string: "1", new_string: "1" }, ctx(d))).toMatch(/identical/);
    expect(await e.run({ file_path: f, old_string: "", new_string: "x" }, ctx(d))).toMatch(/empty/);
    expect(await e.run({ file_path: join(d, "no.txt"), old_string: "a", new_string: "b" }, ctx(d))).toMatch(/does not exist/);
  });
  test("Edit does not interpret replacement patterns ($& and friends)", async () => {
    const d = workdir();
    const f = join(d, "f.txt");
    writeFileSync(f, "price: X\n");
    await tool("Edit").run({ file_path: f, old_string: "X", new_string: "$& $1 $$" }, ctx(d));
    expect(readFileSync(f, "utf8")).toBe("price: $& $1 $$\n");
  });
});

describe("Edit on a file of CRLF lines", () => {
  test("a piece of several lines, written as a model writes lines, is found and the file stays CRLF", async () => {
    const d = workdir();
    const f = join(d, "win.txt");
    writeFileSync(f, "one\r\ntwo\r\nthree\r\n");
    expect(await tool("Edit").run({ file_path: f, old_string: "one\ntwo", new_string: "uno\ndos\ntres" }, ctx(d))).toMatch(/Edited .* at line 1/);
    expect(readFileSync(f, "utf8")).toBe("uno\r\ndos\r\ntres\r\nthree\r\n");
    expect(await tool("Edit").run({ file_path: f, old_string: "dos\r\ntres", new_string: "2\n3" }, ctx(d))).toMatch(/Edited/);
    expect(readFileSync(f, "utf8")).toBe("uno\r\n2\r\n3\r\nthree\r\n");
  });
  test("a file with mixed endings is matched exactly and keeps them", async () => {
    const d = workdir();
    const f = join(d, "mixed.txt");
    writeFileSync(f, "a\r\nb\nc\r\n");
    expect(await tool("Edit").run({ file_path: f, old_string: "b\nc", new_string: "B\nC" }, ctx(d))).toMatch(/Edited/);
    expect(readFileSync(f, "utf8")).toBe("a\r\nB\nC\r\n");
  });
});

describe("Bash", () => {
  test("reports output and the exit code, in the working directory", async () => {
    const d = workdir();
    const ok = await tool("Bash").run({ command: "echo hi && pwd" }, ctx(d));
    expect(ok).toContain("hi");
    expect(ok).toContain(d.split(/[\\/]/).pop()!);
    expect(ok.trimEnd().endsWith("[exit 0]")).toBe(true);
    expect(await tool("Bash").run({ command: "echo bad >&2; exit 3" }, ctx(d))).toMatch(/bad[\s\S]*\[exit 3\]/);
  });
  test("a timeout kills the command and says so", async () => {
    const d = workdir();
    const t0 = Date.now();
    const out = await tool("Bash").run({ command: "sleep 30", timeout: 1 }, ctx(d));
    expect(out).toMatch(/timed out after 1s/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("aborting kills the whole process group (children included)", async () => {
    const d = workdir();
    const ac = new AbortController();
    const p = tool("Bash").run({ command: "sleep 30 & sleep 30; echo never" }, ctx(d, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const out = await p;
    expect(out).toMatch(/\[interrupted\]/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  test("an empty command is rejected", async () => {
    expect(await tool("Bash").run({ command: "  " }, ctx(workdir()))).toMatch(/empty command/);
  });
});

describe("Glob and Grep", () => {
  test("Glob finds files, skips node_modules and .git, newest first", async () => {
    const d = workdir();
    mkdirSync(join(d, "src")); mkdirSync(join(d, "node_modules")); mkdirSync(join(d, ".git"));
    writeFileSync(join(d, "src/old.ts"), "1"); writeFileSync(join(d, "node_modules/skip.ts"), "1"); writeFileSync(join(d, ".git/skip.ts"), "1");
    await Bun.sleep(20);
    writeFileSync(join(d, "src/new.ts"), "2");
    const out = await tool("Glob").run({ pattern: "**/*.ts" }, ctx(d));
    expect(out.split("\n")).toEqual(["src/new.ts", "src/old.ts"]);
    expect(await tool("Glob").run({ pattern: "**/*.rs" }, ctx(d))).toBe("No files matched.");
  });
  test("Grep still works on a machine with neither ripgrep nor grep", async () => {
    const d = workdir(), bin = workdir();
    mkdirSync(join(d, "src")); mkdirSync(join(d, "node_modules"));
    writeFileSync(join(d, "src/a.ts"), "alpha\nNeedle one\nneedle two\n");
    writeFileSync(join(d, "src/b.md"), "needle in docs\n");
    writeFileSync(join(d, "node_modules/x.ts"), "needle skipped\n");
    writeFileSync(join(d, "bin.dat"), "needle\u0000binary");
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(await tool("Grep").run({ pattern: "needle" }, ctx(d))).toBe("src/a.ts:3:needle two\nsrc/b.md:1:needle in docs");
      expect(await tool("Grep").run({ pattern: "needle", ignore_case: true, glob: "*.ts" }, ctx(d))).toBe("src/a.ts:2:Needle one\nsrc/a.ts:3:needle two");
      expect(await tool("Grep").run({ pattern: "zzz" }, ctx(d))).toBe("No matches.");
      expect(await tool("Grep").run({ pattern: "(" }, ctx(d))).toContain("not a valid regular expression");
    } finally { process.env.PATH = saved; }
  });
  test("Grep returns file:line:text relative to the search root, with glob and case options", async () => {
    const d = workdir();
    writeFileSync(join(d, "a.ts"), "const Hello = 1;\nconst other = 2;\n");
    writeFileSync(join(d, "b.md"), "hello there\n");
    const g = tool("Grep");
    const all = await g.run({ pattern: "hello", ignore_case: true }, ctx(d));
    expect(all).toMatch(/a\.ts:1:const Hello/);
    expect(all).toMatch(/b\.md:1:hello there/);
    const onlyTs = await g.run({ pattern: "hello", ignore_case: true, glob: "*.ts" }, ctx(d));
    expect(onlyTs).toMatch(/a\.ts/);
    expect(onlyTs).not.toMatch(/b\.md/);
    expect(await g.run({ pattern: "zzzz" }, ctx(d))).toBe("No matches.");
    expect(await g.run({ pattern: "" }, ctx(d))).toMatch(/empty pattern/);
  });
});

describe("Grep without ripgrep", () => {
  test("falls back to the system grep", async () => {
    const d = workdir();
    const { symlinkSync } = await import("node:fs");
    const grepPath = Bun.which("grep");
    if (!grepPath) return; // no grep on this machine: nothing to test
    // Git's grep on Windows works only next to the libraries in its own folder, which has no ripgrep; elsewhere grep is linked alone.
    let bin = dirname(grepPath);
    if (process.platform !== "win32") { bin = workdir(); symlinkSync(grepPath, join(bin, "grep")); }
    writeFileSync(join(d, "a.ts"), "needle here\n");
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(Bun.which("rg", { PATH: process.env.PATH ?? "" })).toBeNull();
      expect(await tool("Grep").run({ pattern: "needle" }, ctx(d))).toMatch(/a\.ts:1:needle here/);
    } finally { process.env.PATH = saved; }
  });
});

describe("TodoWrite", () => {
  test("emits a plan event with validated entries", async () => {
    const c = ctx(workdir());
    const out = await tool("TodoWrite").run({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "weird" }, { content: "", status: "pending" }, 5] }, c);
    expect(out).toMatch(/2 items/);
    expect(c.emitted[0]).toMatchObject({ ev: "plan", entries: [{ title: "a", status: "in_progress" }, { title: "b", status: "pending" }] });
  });
});

describe("WebFetch", () => {
  test("private and local addresses are refused by default", async () => {
    const f = tool("WebFetch");
    for (const url of ["http://localhost:1/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://service.internal/"]) {
      expect(await f.run({ url }, ctx(workdir()))).toMatch(/not allowed/);
    }
    expect(await f.run({ url: "file:///etc/passwd" }, ctx(workdir()))).toMatch(/only http/);
    expect(await f.run({ url: "not a url" }, ctx(workdir()))).toMatch(/not a valid URL/);
  });
  test("isPrivateHost knows the ranges", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "93.184.216.34"]) expect(isPrivateHost(h)).toBe(false);
  });
  test("with the opt-in it fetches, reduces HTML to text, and reports redirects without following them", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/redir") return new Response(null, { status: 302, headers: { location: "http://example.com/x" } });
        if (p === "/text") return new Response("plain body", { headers: { "content-type": "text/plain" } });
        return new Response("<html><head><style>b{}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>", { headers: { "content-type": "text/html" } });
      },
    });
    try {
      const f = tool("WebFetch");
      const c = ctx(workdir(), { allowPrivateNetwork: true });
      const html = await f.run({ url: `http://127.0.0.1:${server.port}/` }, c);
      expect(html).toContain("Title Hello & welcome");
      expect(html).not.toContain("evil()");
      expect(await f.run({ url: `http://127.0.0.1:${server.port}/text` }, c)).toContain("plain body");
      expect(await f.run({ url: `http://127.0.0.1:${server.port}/redir` }, c)).toMatch(/Redirected \(302\) to http:\/\/example\.com\/x/);
    } finally { server.stop(true); }
  });
});

describe("helpers", () => {
  test("clip keeps the start and the end of long output", () => {
    const text = `HEAD${"m".repeat(100_000)}TAIL`;
    const out = clip(text);
    expect(out.length).toBeLessThan(31_000);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toMatch(/characters omitted/);
    expect(clip("short")).toBe("short");
  });
  test("run never rejects: a missing program is reported", async () => {
    const r = await run(["definitely-not-a-program-xyz"], { cwd: workdir(), signal: new AbortController().signal, timeoutMs: 2000 });
    expect(r.output).toMatch(/Error:/);
    expect(r.code).toBeNull();
  });
  test("run on an already-aborted signal returns at once", async () => {
    const ac = new AbortController(); ac.abort();
    const r = await run(["sleep", "5"], { cwd: workdir(), signal: ac.signal, timeoutMs: 5000 });
    expect(r.interrupted).toBe(true);
  });
});
