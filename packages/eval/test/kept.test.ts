import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptFolder, recheck, secretsOf, snapshot } from "../src/kept.ts";
import { main } from "../src/main.ts";
import { runTask, type TaskResult } from "../src/run.ts";
import type { Task } from "../src/task.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const root = mkdtempSync(join(tmpdir(), "navvied-kept-test-"));
afterAll(hook("the kept-run test removes what it made", async () => { await removeTree(root); }), HOOK_MS);

const KEY = "sk-test-0123456789abcdefKEY";
const OTHER = "ghp-of-the-person-9876543210";

const made = (name: string, files: Record<string, string> = {}): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
  return dir;
};

/** Every file under a folder with its bytes, links not followed. */
const all = (dir: string): { path: string; text: string }[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const path = join(dir, e.name);
  return e.isDirectory() ? all(path) : e.isFile() ? [{ path, text: readFileSync(path, "latin1") }] : [{ path, text: "(a link or something else)" }];
});

// An agent that leaves its key everywhere a file can be: it stands in for a model that read its own environment.
const AGENT = `
const { mkdirSync, writeFileSync, symlinkSync } = require("node:fs");
const { gzipSync } = require("node:zlib");
const key = process.env.NAVVIED_API_KEY, other = process.env.SOME_SERVICE_TOKEN;
const put = (path, data) => { mkdirSync(require("node:path").dirname(path), { recursive: true }); writeFileSync(path, data); };
put("answer.txt", process.env.BENCH_SECRET + (process.env.RIGHT ? "" : " not yet"));
put("notes/key.txt", "the key is " + key + " and " + other + "\\n");
put(".state/session.json", JSON.stringify({ key }));
put("blob.bin", Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(key), Buffer.from([254, 0])]));
put("packed.gz", gzipSync(key));
put(key + ".txt", "named after it");
put("node_modules/x/index.js", key);
put("huge.log", "a".repeat(3 * 1024 * 1024));
put("run.sh", "#!/bin/sh\\n");
require("node:fs").chmodSync("run.sh", 0o755);
if (process.platform !== "win32") symlinkSync(process.env.KEY_FILE_AT, "link-to-key");
if (process.env.COMMIT) Bun.spawnSync(["git", "init", "-q", "--bare", "mirror"]);
if (process.env.COMMIT) for (const args of [["add", process.env.COMMIT], ["commit", "-qm", "more"]]) Bun.spawnSync(["git", ...args]);
if (process.env.COMMIT) Bun.spawnSync(["git", "--git-dir=mirror", "hash-object", "-w", "notes/key.txt"]);
console.log(JSON.stringify({ ev: "text", text: "I saw " + key + " " + other }));
console.error("error output with " + key);
`;

const taskIn = (dir: string): Task => ({ id: "kept-demo", title: "kept", kind: "terminal", level: 1, lang: "none", requires: [], slow: false, prompt: "write the answer", protect: [], maxSteps: 3, timeoutSeconds: 60, dir, check: 'echo looked >> checked.log; test "$(cat answer.txt)" = "$BENCH_SECRET"' });

describe("a run that did not solve its task is kept", () => {
  const task = taskIn(made("task", { "repo/README.md": "# demo\n", "solution/answer.txt": "" }));
  const agent = join(made("agent", { "agent.js": AGENT }), "agent.js");
  const outside = join(made("outside", { "bench.key": KEY }), "bench.key");
  const run = (name: string, env: Record<string, string> = {}, keep = true): Promise<TaskResult> => runTask(task, { command: [process.execPath, agent], key: KEY, env: { NAVVIED_API_KEY: KEY, SOME_SERVICE_TOKEN: OTHER, KEY_FILE_AT: outside, ...env }, trace: join(root, name, "trace"), ...(keep ? { keepFailed: join(root, name, "failed") } : {}) });

  const agentSaid = (name: string, r: TaskResult): string => (r.reason === "agent failed" ? readFileSync(join(root, name, "trace", `${task.id}.stderr.txt`), "utf8").split("\n").filter((line) => line.trim() !== "").slice(0, 8).join("\n") : "");

  test("with its workspace, check and secret, and with no key anywhere in what was written", async () => {
    const r = await run("fail", { COMMIT: "notes/key.txt" });
    expect([r.reason, agentSaid("fail", r)]).toEqual(["check failed", ""]);
    const kept = r.kept!;
    expect(readdirSync(kept).sort()).toEqual(["check.json", "secret", "workspace"]);
    const written = [...all(join(root, "fail")), { path: "the result", text: JSON.stringify(r) }];
    expect(written.length).toBeGreaterThan(6);
    for (const f of written) for (const secret of [KEY, OTHER]) { expect(f.text, f.path).not.toContain(secret); expect(f.path).not.toContain(secret); }
    const ws = join(kept, "workspace");
    expect(readFileSync(join(ws, "notes/key.txt"), "utf8")).toBe("the key is [key] and [key]\n");
    expect(readFileSync(join(ws, ".state/session.json"), "utf8")).toBe('{"key":"[key]"}');
    expect([...readFileSync(join(ws, "blob.bin"))]).toEqual([0, 255, 128, ...Buffer.from("[key]"), 254, 0]);
    expect(readFileSync(join(ws, ".bench-events.jsonl"), "utf8")).toContain("I saw [key] [key]");
    for (const gone of ["packed.gz", "node_modules", "huge.log", "link-to-key", ".git", "mirror"]) expect(existsSync(join(ws, gone)), gone).toBe(false);
    const about = JSON.parse(readFileSync(join(kept, "check.json"), "utf8")) as { skipped: string[]; reason: string; check: string };
    expect(about).toMatchObject({ task: "kept-demo", reason: "check failed", check: task.check });
    const why = about.skipped.join("\n");
    for (const part of ["packed.gz: packed", "node_modules/: installed or generated", "huge.log: 3145728 bytes", "[key].txt: its name holds a key", ".git/: git holds a key", "mirror/: git holds a key"]) expect(why).toContain(part);
    if (process.platform !== "win32") {
      expect(why).toContain("link-to-key: a link");
      expect(statSync(join(kept, "secret")).mode & 0o777).toBe(0o600);
      expect(statSync(join(ws, "run.sh")).mode & 0o111).not.toBe(0);
    }
  }, 60_000);

  test("its check runs again on a copy: the same miss, and a pass once the answer is put right, so the secret is the run's own", async () => {
    const r = await run("again");
    const ws = join(r.kept!, "workspace");
    // The copy was taken before the check ran, and neither check wrote into it.
    expect((await recheck(r.kept!)).ok).toBe(false);
    expect(existsSync(join(ws, "checked.log"))).toBe(false);
    // A git folder with no key in any object comes along.
    expect(Bun.spawnSync(["git", "log", "--format=%s"], { cwd: ws }).stdout.toString().trim()).toBe("start");
    const secret = readFileSync(join(r.kept!, "secret"), "utf8");
    expect(readFileSync(join(ws, "answer.txt"), "utf8")).toBe(`${secret} not yet`);
    writeFileSync(join(ws, "answer.txt"), secret);
    expect((await recheck(r.kept!)).ok).toBe(true);
  }, 60_000);

  test("a copy that cannot be written is said, and the result of the run is not lost", async () => {
    const taken = join(made("blocked"), "a-file");
    writeFileSync(taken, "");
    const quiet = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      const r = await runTask(task, { command: [process.execPath, agent], key: KEY, env: { NAVVIED_API_KEY: KEY, SOME_SERVICE_TOKEN: OTHER, KEY_FILE_AT: outside }, keepFailed: taken });
      expect([r.reason, r.kept]).toEqual(["check failed", undefined]);
      expect(String(quiet.mock.calls.at(-1)?.[0])).toStartWith("not kept: ");
    } finally { quiet.mockRestore(); }
  }, 60_000);

  test("a run that passes keeps nothing, and neither does a run with no folder asked for", async () => {
    const good = await run("pass", { RIGHT: "1" });
    expect(good.passed).toBe(true);
    expect(good.kept).toBeUndefined();
    expect(existsSync(join(root, "pass", "failed"))).toBe(false);
    expect((await run("unasked", {}, false)).kept).toBeUndefined();
  }, 60_000);
});

describe("the limits and the names", () => {
  test("the whole copy and the number of files are bounded, and what is left out is counted", () => {
    const dir = made("many", Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, "0123456789"])));
    const copy = snapshot(dir, [], { fileBytes: 100, totalBytes: 55, files: 100 });
    expect(copy.files).toHaveLength(5);
    expect(copy.skipped).toHaveLength(100);
    expect(copy.skipped[0]).toBe("f005.txt: over the limit on the whole copy");
    expect(copy.more).toBe(25);
    expect(snapshot(dir, [], { fileBytes: 100, totalBytes: 10_000, files: 3 }).files).toHaveLength(3);
  });

  test("a secret is a key that was given or a variable named as one, never a value the fixtures are made from", () => {
    expect(secretsOf([KEY, undefined, "none", "short"], { A_TOKEN: OTHER, BENCH_SECRET: "0123456789abcdef", HOME: "/home/somebody" })).toEqual([OTHER, KEY].sort((a, b) => b.length - a.length));
  });

  test("the folder is beside the trace, else beside the results, else there is none", () => {
    expect(keptFolder(join(root, "t"), join(root, "r.jsonl"))).toBe(join(root, "t", "failed"));
    expect(keptFolder(undefined, join(root, "r.jsonl"))).toBe(join(root, "r.jsonl.failed"));
    expect(keptFolder()).toBeUndefined();
  });

  test("from the command line, with the scripted model: the failed run is kept beside the results, and recheck says its check fails", async () => {
    const out = join(made("cli"), "results.jsonl");
    const said: string[] = [];
    const quiet = [spyOn(process.stdout, "write").mockImplementation(((s: string) => { said.push(String(s)); return true; }) as never), spyOn(process.stderr, "write").mockImplementation((() => true) as never)];
    try {
      expect(await main(["run", "--mock", "lazy", "--tasks", "fix-off-by-one", "--out", out, "--upstream-key", KEY])).toBe(1);
      const r = JSON.parse(readFileSync(out, "utf8")) as TaskResult;
      expect(r.kept!.startsWith(join(`${out}.failed`, "fix-off-by-one-"))).toBe(true);
      for (const f of all(`${out}.failed`)) expect(f.text, f.path).not.toContain(KEY);
      said.length = 0;
      expect(await main(["recheck", r.kept!])).toBe(1);
      expect(said.join("")).toContain("fix-off-by-one: the check fails (the run ended: check failed)");
      expect(await main(["recheck", root])).toBe(2);
    } finally { for (const q of quiet) q.mockRestore(); }
  }, 60_000);
});
