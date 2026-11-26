import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints, spawnGit } from "../src/index.ts";
import { cleanupAll, prompt, rig, type Step } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "navvied-cp-"))); dirs.push(d); return d; };
afterAll(hook("checkpoints removes what it made", async () => { await stopAllJobs(); await cleanupAll(); await removeTrees(dirs); }), HOOK_MS);

const git = (cwd: string, ...args: string[]) => { const r = spawnGit(cwd, args); if (!r.ok) throw new Error(`git ${args.join(" ")} failed`); return r.out; };
const put = (dir: string, name: string, text: string) => { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), text); };
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

function repo(files: Record<string, string> = { "a.txt": "one\n", "b.txt": "keep\n" }, commit = true): string {
  const dir = tmp();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.invalid");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  put(dir, ".gitignore", "node_modules/\n");
  for (const [n, t] of Object.entries(files)) put(dir, n, t);
  if (commit) { git(dir, "add", "-A"); git(dir, "commit", "-qm", "init"); }
  return dir;
}
const store = (session = "s1", extra: { limit?: number } = {}) => new Checkpoints({ dir: join(tmp(), "cp"), session, ...extra });

describe("repository detection", () => {
  test("finds the root from a file, from a path that does not exist yet, and rejects the rest", () => {
    const d = repo(), c = store();
    const same = (a: string | null) => a?.replace(/\\/g, "/").toLowerCase();
    expect(same(c.repoOf(join(d, "a.txt")))).toBe(same(realpathSync.native(d)));
    expect(same(c.repoOf(join(d, "new/dir/file.ts")))).toBe(same(realpathSync.native(d)));
    expect(c.repoOf(tmp())).toBeNull();
    expect(c.repoOf("relative/path")).toBeNull();
  });
});

describe("taking checkpoints", () => {
  test("is saved only once it holds a repository; label is tidied", () => {
    const d = repo(), c = store();
    const cp = c.begin("  fix   the\nbug  ", []);
    expect(cp.repos).toEqual([]);
    expect(c.list()).toEqual([]);
    expect(c.add(cp, join(d, "a.txt"))).toBe(true);
    expect(c.add(cp, join(d, "b.txt"))).toBe(false); // the same repository again
    expect(c.add(cp, tmp())).toBe(false); // not a repository
    expect(c.info()).toEqual([{ id: cp.id, at: cp.at, label: "fix the bug", repos: [expect.any(String)] }]);
  });

  test("never touches the repository's own index, HEAD or files", () => {
    const d = repo();
    put(d, "a.txt", "changed\n"); put(d, "new.txt", "untracked\n");
    const before = { status: git(d, "status", "--porcelain"), head: git(d, "rev-parse", "HEAD"), cached: git(d, "diff", "--cached") };
    store().begin("x", [d]);
    expect({ status: git(d, "status", "--porcelain"), head: git(d, "rev-parse", "HEAD"), cached: git(d, "diff", "--cached") }).toEqual(before);
    expect(read(d, "a.txt")).toBe("changed\n");
  });

  test("survives a restart: another instance sees the same checkpoints", () => {
    const d = repo(), dir = join(tmp(), "cp");
    const a = new Checkpoints({ dir, session: "same" });
    a.begin("first", [d]);
    expect(new Checkpoints({ dir, session: "same" }).info().map((c) => c.label)).toEqual(["first"]);
    expect(new Checkpoints({ dir, session: "other" }).info()).toEqual([]);
  });

  test("keeps only the newest `limit` and drops the old snapshots from the repository", () => {
    const d = repo(), c = store("lim", { limit: 2 });
    for (const n of ["one", "two", "three"]) c.begin(n, [d]);
    expect(c.info().map((x) => x.label)).toEqual(["two", "three"]);
    expect(git(d, "for-each-ref", "refs/navvied/checkpoints/lim").trim().split("\n")).toHaveLength(2);
  });

  test("a bad session id is refused; a damaged index file reads as empty", () => {
    expect(() => new Checkpoints({ dir: tmp(), session: "../escape" })).toThrow(/invalid session id/);
    const dir = join(tmp(), "cp"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{not json");
    expect(new Checkpoints({ dir, session: "broken" }).list()).toEqual([]);
  });
});

describe("restoring", () => {
  test("gives back the same bytes in a repository that converts line endings, as every one does with Git for Windows", () => {
    const d = repo({ "lf.txt": "one\ntwo\n", "crlf.txt": "one\r\ntwo\r\n" });
    git(d, "config", "core.autocrlf", "true");
    const c = store();
    const cp = c.begin("before work", [d]);
    put(d, "lf.txt", "changed\n");
    put(d, "crlf.txt", "changed\r\n");
    expect(c.restore(cp.id)!.errors).toEqual([]);
    expect(read(d, "lf.txt")).toBe("one\ntwo\n");
    expect(read(d, "crlf.txt")).toBe("one\r\ntwo\r\n");
  });
  test("edits are reverted, deleted files return, created files go; ignored files and the index stay as they are", () => {
    const d = repo();
    put(d, "u.txt", "untracked before\n");
    put(d, "node_modules/x.js", "ignored\n");
    const c = store();
    const cp = c.begin("before work", [d]);

    put(d, "a.txt", "one\ntwo\n");
    rmSync(join(d, "b.txt"));
    put(d, "c.txt", "created later\n");
    put(d, "u.txt", "changed\n");
    put(d, "node_modules/x.js", "ignored but changed\n");

    expect(c.preview(cp.id)!.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { repo: expect.any(String), path: "a.txt", change: "revert" },
      { repo: expect.any(String), path: "b.txt", change: "recreate" },
      { repo: expect.any(String), path: "c.txt", change: "remove" },
      { repo: expect.any(String), path: "u.txt", change: "revert" },
    ]);

    const done = c.restore(cp.id)!;
    expect(done.errors).toEqual([]);
    expect(done.changes).toHaveLength(4);
    expect(read(d, "a.txt")).toBe("one\n");
    expect(read(d, "b.txt")).toBe("keep\n");
    expect(existsSync(join(d, "c.txt"))).toBe(false);
    expect(read(d, "u.txt")).toBe("untracked before\n");
    expect(read(d, "node_modules/x.js")).toBe("ignored but changed\n");
    expect(git(d, "diff", "--cached").trim()).toBe("");
    expect(git(d, "status", "--porcelain").trim()).toBe("?? u.txt");
  });

  test("a restore saves the current state first, so it can be undone", () => {
    const d = repo(), c = store();
    const cp = c.begin("start", [d]);
    put(d, "a.txt", "agent edit\n"); put(d, "new.txt", "agent file\n"); rmSync(join(d, "b.txt"));
    const done = c.restore(cp.id)!;
    expect(done.undoId).toBeDefined();
    expect(read(d, "a.txt")).toBe("one\n");
    const undone = c.restore(done.undoId!)!;
    expect(undone.errors).toEqual([]);
    expect(read(d, "a.txt")).toBe("agent edit\n");
    expect(read(d, "new.txt")).toBe("agent file\n");
    expect(existsSync(join(d, "b.txt"))).toBe(false);
  });

  test("nothing changed → nothing to restore", () => {
    const d = repo(), c = store();
    const cp = c.begin("x", [d]);
    expect(c.preview(cp.id)).toEqual([]);
    expect(c.restore(cp.id)!.changes).toEqual([]);
  });

  test("works in a repository with no commits yet, with awkward file names and binary files", () => {
    const d = repo({}, false), c = store();
    put(d, "my file (1).txt", "spaced\n"); put(d, "naïve — ünï.txt", "unicode\n");
    writeFileSync(join(d, "image.bin"), Buffer.from([0, 1, 2, 255, 0, 9]));
    const cp = c.begin("empty repo", [d]);
    put(d, "my file (1).txt", "changed\n"); rmSync(join(d, "naïve — ünï.txt")); writeFileSync(join(d, "image.bin"), Buffer.from([7, 7]));
    expect(c.restore(cp.id)!.errors).toEqual([]);
    expect(read(d, "my file (1).txt")).toBe("spaced\n");
    expect(read(d, "naïve — ünï.txt")).toBe("unicode\n");
    expect([...readFileSync(join(d, "image.bin"))]).toEqual([0, 1, 2, 255, 0, 9]);
  });

  test("several repositories restore together, each by its own snapshot", () => {
    const a = repo({ "f.txt": "a1\n" }), b = repo({ "f.txt": "b1\n" }), c = store();
    const cp = c.begin("two repos", [a, b]);
    put(a, "f.txt", "a2\n"); put(b, "f.txt", "b2\n");
    c.restore(cp.id);
    expect(read(a, "f.txt")).toBe("a1\n");
    expect(read(b, "f.txt")).toBe("b1\n");
  });

  test("an unknown checkpoint is reported as such", () => {
    const c = store();
    expect(c.preview("nope")).toBeNull();
    expect(c.restore("nope")).toBeNull();
  });

  test("a failing git is reported, not thrown", () => {
    const d = repo();
    let breakCheckout = false;
    const c = new Checkpoints({ dir: join(tmp(), "cp"), session: "g", git: (cwd, args, o) => (breakCheckout && args[0] === "checkout" ? { ok: false, out: "" } : spawnGit(cwd, args, o)) });
    const cp = c.begin("x", [d]);
    put(d, "a.txt", "edited\n");
    breakCheckout = true;
    expect(c.restore(cp.id)!.errors).toEqual([expect.stringMatching(/could not restore files/)]);
  });
});

describe("in the engine", () => {
  // The model reads a file before it replaces it, as the tools require.
  const writer = (dir: string, name: string, content: string) => (req: { messages: { role: string }[] }): Step => {
    const done = req.messages.filter((m) => m.role === "tool").length;
    return done === 0 ? { calls: [{ name: "Read", args: { file_path: join(dir, name) } }] } : done === 1 ? { calls: [{ name: "Write", args: { file_path: join(dir, name), content } }] } : { text: "done" };
  };

  test("capability is announced only when checkpoints are configured", () => {
    const plain = rig(() => ({ text: "x" }));
    expect(plain.of("caps")[0]).not.toHaveProperty("checkpoints");
    const d = repo(); const withCp = rig(() => ({ text: "x" }), { cwd: d, checkpoints: store() });
    expect(withCp.of("caps")[0]).toMatchObject({ checkpoints: true });
    plain.cleanup(); withCp.cleanup();
  });

  test("a turn is checkpointed before the agent changes anything; list, preview and restore work through commands", async () => {
    const d = repo();
    const r = rig((req) => writer(d, "a.txt", "agent was here\n")(req), { cwd: d, checkpoints: store() });
    await r.turn(prompt("change the file"));
    expect(read(d, "a.txt")).toBe("agent was here\n");

    let t = await r.turn({ cmd: "checkpoints" });
    const items = (t.find((e) => e.ev === "checkpoints") as { items: { id: string; label: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("change the file");

    t = await r.turn({ cmd: "restore", id: items[0]!.id, preview: true });
    expect(t.find((e) => e.ev === "restore")).toMatchObject({ preview: true, changes: [{ path: "a.txt", change: "revert" }] });
    expect(read(d, "a.txt")).toBe("agent was here\n");

    t = await r.turn({ cmd: "restore", id: items[0]!.id });
    expect(t.find((e) => e.ev === "restore")).toMatchObject({ preview: false, undoId: expect.any(String) });
    expect(read(d, "a.txt")).toBe("one\n");
    r.cleanup();
  });

  test("every file an apply_patch changes is covered by the turn's checkpoint", async () => {
    const d = repo();
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** Update File: b.txt\n@@\n-keep\n+kept\n*** Add File: c.txt\n+new\n*** End Patch";
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "done" } : { calls: [{ name: "apply_patch", args: { patch } }] }), { cwd: d, checkpoints: store(), applyPatch: "on" });
    await r.turn(prompt("change three files"));
    expect([read(d, "a.txt"), read(d, "b.txt"), read(d, "c.txt")]).toEqual(["uno\n", "kept\n", "new\n"]);
    const id = ((await r.turn({ cmd: "checkpoints" })).find((e) => e.ev === "checkpoints") as unknown as { items: { id: string }[] }).items[0]!.id;
    await r.turn({ cmd: "restore", id });
    expect([read(d, "a.txt"), read(d, "b.txt"), existsSync(join(d, "c.txt"))]).toEqual(["one\n", "keep\n", false]);
    r.cleanup();
  });

  test("the first edit in a repository the session had not touched is covered too", async () => {
    const work = tmp(), d = repo();
    const r = rig((req) => writer(d, "a.txt", "edited elsewhere\n")(req), { cwd: work, checkpoints: store() });
    await r.turn(prompt("edit the other repo"));
    const items = (await r.turn({ cmd: "checkpoints" })).find((e) => e.ev === "checkpoints") as { items: { repos: string[] }[] };
    expect(items.items[0]!.repos).toHaveLength(1);
    const id = (items.items[0] as unknown as { id: string }).id;
    await r.turn({ cmd: "restore", id });
    expect(read(d, "a.txt")).toBe("one\n");
    r.cleanup();
  });

  test("no repository, no checkpoint; a message that steers a running turn adds none", async () => {
    const plain = tmp();
    const r = rig(() => ({ text: "ok" }), { cwd: plain, checkpoints: store() });
    await r.turn(prompt("nothing to protect"));
    expect(r.of("checkpoints")).toEqual([]);
    expect((await r.turn({ cmd: "checkpoints" })).find((e) => e.ev === "checkpoints")).toEqual({ ev: "checkpoints", items: [] });
    r.cleanup();

    const d = repo();
    const s = rig((req) => (req.messages.at(-1)?.role === "tool" || req.messages.some((m) => String(m.content).includes("steer")) ? { text: "ok" } : { calls: [{ name: "Bash", args: { command: "sleep 0.3" } }] }), { cwd: d, checkpoints: store("steer") });
    s.send(prompt("long task"));
    await s.when(() => s.of("tool").some((e) => e.status === "running" && e.input !== undefined));
    s.send(prompt("steer it"));
    await s.engine.idle();
    expect(((await s.turn({ cmd: "checkpoints" })).find((e) => e.ev === "checkpoints") as { items: unknown[] }).items).toHaveLength(1);
    s.cleanup();
  });

  test("restore is refused while a turn runs; unknown ids and a missing feature are explained", async () => {
    const d = repo();
    const r = rig(() => ({ text: "slow", delayMs: 300 }), { cwd: d, checkpoints: store() });
    r.send(prompt("go"));
    await r.when(() => r.of("text").length > 0);
    r.send({ cmd: "restore", id: "x" });
    await r.engine.idle();
    expect(r.of("error").some((e) => /Wait for the current turn/.test(e.msg))).toBe(true);
    expect((await r.turn({ cmd: "restore", id: "missing" })).find((e) => e.ev === "error")).toMatchObject({ msg: "That checkpoint was not found." });
    expect((await r.turn({ cmd: "restore", id: "missing", preview: true })).find((e) => e.ev === "error")).toMatchObject({ msg: "That checkpoint was not found." });
    r.cleanup();

    const off = rig(() => ({ text: "x" }));
    expect((await off.turn({ cmd: "checkpoints" })).find((e) => e.ev === "error")).toMatchObject({ msg: "Checkpoints are not enabled for this session." });
    expect((await off.turn({ cmd: "restore", id: "x" })).find((e) => e.ev === "error")).toMatchObject({ msg: "Checkpoints are not enabled for this session." });
    off.cleanup();
  });
});
