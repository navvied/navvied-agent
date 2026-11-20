import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints, Engine, type SessionStore, type Tool } from "../src/index.ts";
import { cleanupAll, prompt, rig, ScriptedProvider, type Step } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "navvied-hard-"))); dirs.push(d); return d; };
afterAll(hook("hardening removes what it made", async () => { await stopAllJobs(); await cleanupAll(); await removeTrees(dirs); }), HOOK_MS);

const toolRoles = (r: ReturnType<typeof rig>, call: number) => r.provider.requests[call]!.messages.map((m) => m.role);

describe("the conversation stays valid after a failure", () => {
  test("a stream that dies after partial text leaves no half-written reply behind", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? { text: "partial answer", fail: "connection reset" } : { text: "ok" }));
    await r.turn(prompt("first"));
    await r.turn(prompt("second"));
    const second = r.provider.requests[1]!.messages;
    expect(second.some((m) => m.role === "assistant")).toBe(false);
    expect(second.filter((m) => m.role === "user")).toHaveLength(2);
    r.cleanup();
  });

  test("every tool call the model made gets a result, even when the turn is cancelled during the tools", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" || String(req.messages.at(-1)?.content) === "again" ? { text: "ok" } : { calls: [{ name: "Bash", args: { command: "sleep 30" } }, { name: "Read", args: { file_path: "x" } }] }));
    r.send(prompt("go"));
    await new Promise((res) => setTimeout(res, 250));
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    await r.turn(prompt("again"));
    const roles = toolRoles(r, 1);
    const assistantAt = roles.indexOf("assistant");
    expect(roles.slice(assistantAt + 1, assistantAt + 3)).toEqual(["tool", "tool"]);
    r.cleanup();
  });

  test("a reply with neither text nor tool calls is not stored as an empty message", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? { text: "" } : { text: "fine" }));
    await r.turn(prompt("one"));
    await r.turn(prompt("two"));
    expect(r.provider.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "user"]);
    r.cleanup();
  });

  test("a tool call with an empty name or null arguments is an error the model can read, not a crash", async () => {
    let n = 0;
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "handled" } : n++ === 0 ? { calls: [{ name: "", args: {} }] } : { calls: [{ name: "Read", rawArgs: "null" }] }));
    const a = await r.turn(prompt("one"));
    expect(a.some((e) => e.ev === "tool" && e.status === "error" && /there is no tool/.test(e.output ?? ""))).toBe(true);
    const b = await r.turn(prompt("two"));
    expect(b.some((e) => e.ev === "tool" && e.status === "error" && /must be a JSON object such as \{"file_path": "\.\.\."\}/.test(e.output ?? ""))).toBe(true);
    expect(b.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });
});

describe("a broken collaborator never takes the engine down", () => {
  test("a session store that cannot write does not stop the turn", async () => {
    const store: SessionStore = { save() { throw new Error("disk full"); }, load: () => null };
    const r = rig(() => ({ text: "ok" }), { store });
    expect((await r.turn(prompt("hi"))).at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });

  test("instructions that throw are skipped", async () => {
    const r = rig(() => ({ text: "ok" }), { instructions: () => { throw new Error("unreadable"); } });
    const t = await r.turn(prompt("hi"));
    expect(t.some((e) => e.ev === "error")).toBe(false);
    expect(r.provider.requests[0]!.system).not.toContain("standing instructions");
    r.cleanup();
  });

  test("checkpoints whose git is missing or throws do not stop the work", async () => {
    const d = tmp();
    const checkpoints = new Checkpoints({ dir: join(d, "cp"), session: "s", git: () => { throw new Error("git not installed"); } });
    const r = rig(() => ({ text: "ok" }), { cwd: d, checkpoints });
    expect((await r.turn(prompt("hi"))).at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect((await r.turn({ cmd: "checkpoints" })).find((e) => e.ev === "checkpoints")).toEqual({ ev: "checkpoints", items: [] });
    r.cleanup();
  });

  test("an approval title that throws still asks, with a plain title", async () => {
    const odd: Tool = { name: "Odd", description: "d", parameters: { type: "object" }, readOnly: false, title: () => { throw new Error("no title"); }, run: async () => "ran" };
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "ok" } : { calls: [{ name: "Odd", args: {} }] }), { tools: [odd] });
    r.send(prompt("go", { mode: "ask" }));
    await new Promise((res) => setTimeout(res, 100));
    const card = r.of("approval")[0];
    expect(card?.title).toBe("Run Odd");
    r.send({ cmd: "approve", id: card!.id, optionId: "allow" });
    await r.engine.idle();
    r.cleanup();
  });

  test("a tool that throws is reported as a tool error and the turn goes on", async () => {
    const boom: Tool = { name: "Boom", description: "d", parameters: { type: "object" }, readOnly: true, title: () => "boom", run: async () => { throw new Error("kaboom"); } };
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "ok" } : { calls: [{ name: "Boom", args: {} }] }), { tools: [boom] });
    const t = await r.turn(prompt("go"));
    expect(t.some((e) => e.ev === "tool" && e.status === "error" && /kaboom/.test(e.output ?? ""))).toBe(true);
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });

  test("a front-end whose event handler throws cannot corrupt the conversation", async () => {
    const d = tmp();
    let boom = false;
    const provider = new ScriptedProvider(() => ({ text: "hello there" }));
    const engine = new Engine({ provider, cwd: d, window: 100_000, heartbeatMs: 0, emit: (e) => { if (boom && e.ev === "text") throw new Error("ui bug"); } });
    boom = true;
    engine.handle({ cmd: "prompt", text: "one" });
    await engine.idle();
    boom = false;
    engine.handle({ cmd: "prompt", text: "two" });
    await engine.idle();
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.messages.map((m) => m.role)).not.toContain("tool");
    engine.close();
  });
});

describe("cancelling at awkward moments", () => {
  test("cancelling during compaction stops it and leaves the conversation as it was", async () => {
    const r = rig(() => ({ text: "answer" }));
    for (let i = 0; i < 4; i++) await r.turn(prompt(`question ${i} ${"x".repeat(400)}`));
    const before = r.provider.requests.at(-1)!.messages.length;
    const slow = r.provider;
    slow.complete = (_s: string, _u: string, signal: AbortSignal) => new Promise<string>((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    r.send({ cmd: "compact" });
    await new Promise((res) => setTimeout(res, 100));
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    await r.turn(prompt("still here"));
    expect(r.provider.requests.at(-1)!.messages.length).toBeGreaterThanOrEqual(before);
    r.cleanup();
  });

  test("a prompt sent the instant the previous turn ends is not lost", async () => {
    const r = rig((req) => ({ text: `answer to ${req.messages.filter((m) => m.role === "user").length}` }));
    r.send(prompt("one"));
    await r.engine.idle();
    r.send(prompt("two"));
    r.send(prompt("three"));
    await r.engine.idle();
    expect(r.text()).toContain("answer to 1");
    expect(r.provider.requests.flatMap((q) => q.messages).filter((m) => m.role === "user" && String(m.content) === "three")).not.toHaveLength(0);
    r.cleanup();
  });

  test("closing the engine mid-turn releases everyone waiting", async () => {
    const r = rig(() => ({ text: "slow", delayMs: 5000 }));
    r.send(prompt("go"));
    await new Promise((res) => setTimeout(res, 50));
    const waiting = r.engine.idle();
    r.engine.close();
    await Promise.race([waiting, new Promise((_, rej) => setTimeout(() => rej(new Error("idle() hung")), 3000))]);
  });
});

describe("files and paths", () => {
  test("a path with spaces, unicode or a missing parent directory works for Write, Edit and Read", async () => {
    const d = tmp();
    const file = join(d, "new dir", "naïve — file (1).txt");
    let step = 0;
    const r = rig((req): Step => {
      if (req.messages.at(-1)?.role === "tool" && step >= 3) return { text: "done" };
      step++;
      return [{ calls: [{ name: "Write", args: { file_path: file, content: "a\nb\n" } }] }, { calls: [{ name: "Edit", args: { file_path: file, old_string: "b", new_string: "c" } }] }, { calls: [{ name: "Read", args: { file_path: file } }] }][step - 1] ?? { text: "done" };
    }, { cwd: d });
    const t = await r.turn(prompt("go"));
    expect(t.some((e) => e.ev === "tool" && e.name === "Read" && e.status === "done" && /2\tc/.test(e.output ?? ""))).toBe(true);
    r.cleanup();
  });

  test("a symbolic link inside a repository is restored as the link, never followed out of it", async () => {
    const d = tmp(), outside = tmp();
    writeFileSync(join(outside, "secret.txt"), "outside");
    mkdirSync(join(d, ".git"), { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "t@t.invalid"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", ...args], { cwd: d });
    writeFileSync(join(d, "a.txt"), "one\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: d });
    Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: d });
    const c = new Checkpoints({ dir: join(tmp(), "cp"), session: "sym" });
    const cp = c.begin("x", [d]);
    Bun.spawnSync(["ln", "-s", join(outside, "secret.txt"), join(d, "link")]);
    c.restore(cp.id);
    expect(Bun.file(join(outside, "secret.txt")).size).toBe("outside".length);
  });
});
