import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, EngineEvent, PermMode } from "@navvied/protocol";
import { ASK_ADDRESS, ASK_TOKEN, AskServer, askEngine, StreamEngine } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const FAKE = join(import.meta.dir, "fake-agent.ts");
const STUB = join(import.meta.dir, "hook-stub.ts");
const dirs: string[] = [];
afterAll(hook("stream-engine-ask removes what it made", async () => { await removeTrees(dirs); }), HOOK_MS);

type Tool = Extract<EngineEvent, { ev: "tool" }>;
type Approval = Extract<EngineEvent, { ev: "approval" }>;

function rig(guard = `bun "${STUB}"`) {
  const dir = mkdtempSync(join(tmpdir(), "navvied-ask-")); dirs.push(dir);
  const events: EngineEvent[] = [];
  const engine = new StreamEngine({ command: "bun", args: [FAKE], cwd: dir, window: 100_000, emit: (e) => events.push(e), heartbeatMs: 0, guard });
  const approvals = (): Approval[] => events.filter((e): e is Approval => e.ev === "approval");
  const results = (): string[] => events.filter((e): e is Tool => e.ev === "tool" && e.status !== "running").map((e) => e.output ?? "");
  const send = (command: string, mode: PermMode): void => { engine.handle({ cmd: "prompt", text: `run bash: ${command}`, mode } as Command); };
  const answer = async (optionId: string, input?: string): Promise<void> => {
    const n = approvals().length;
    await until(() => n > 0);
    engine.handle({ cmd: "approve", id: approvals().at(-1)!.id, optionId, ...(input !== undefined ? { input } : {}) });
  };
  return { engine, events, approvals, results, send, answer };
}
const until = async (pred: () => boolean, ms = 8000): Promise<void> => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("condition not met"); await new Promise((r) => setTimeout(r, 15)); } };

describe("a program's tool is asked about the way the built-in engine's is", () => {
  test("Ask: the person is asked in the usual card, and Allow lets the tool run", async () => {
    const r = rig();
    r.send("npm test", "ask");
    await until(() => r.approvals().length === 1);
    const card = r.approvals()[0]!;
    expect(card.title).toBe("Run npm test");
    expect(card.options.map((o) => o.optionId)).toEqual(["allow", "allow_always", "edit", "deny"]);
    expect(card.tool).toMatch(/^hook/);
    r.engine.handle({ cmd: "approve", id: card.id, optionId: "allow" });
    await r.engine.idle();
    expect(r.results()).toEqual(["ran: npm test"]);
    r.engine.close();
  });

  test("a no is told to the model, with the person's own words when they gave some", async () => {
    const r = rig();
    r.send("rm -r build", "ask");
    await until(() => r.approvals().length === 1);
    r.engine.handle({ cmd: "approve", id: r.approvals()[0]!.id, optionId: "deny", input: "delete only build/tmp" });
    await r.engine.idle();
    expect(r.results()).toEqual(["Not run. The person said: delete only build/tmp"]);
    r.send("rm -r dist", "ask");
    await until(() => r.approvals().length === 2);
    r.engine.handle({ cmd: "approve", id: r.approvals()[1]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(r.results().at(-1)).toBe("The user denied this action.");
    r.engine.close();
  });

  test("Edit changes the command that runs, and what is never done stays refused even when edited into", async () => {
    const r = rig();
    r.send("npm test", "ask");
    await until(() => r.approvals().length === 1);
    r.engine.handle({ cmd: "approve", id: r.approvals()[0]!.id, optionId: "edit", input: "npm run lint" });
    await r.engine.idle();
    expect(r.results()).toEqual(["ran: npm run lint"]);
    r.send("npm test", "ask");
    await until(() => r.approvals().length === 2);
    r.engine.handle({ cmd: "approve", id: r.approvals()[1]!.id, optionId: "edit", input: "rm -rf ~" });
    await r.engine.idle();
    expect(r.results().at(-1)).toContain("navvied never does this");
    r.engine.close();
  });

  test("\"Do not ask again\" is remembered for that kind of command, and a different kind is still asked", async () => {
    const r = rig();
    r.send("npm test", "ask");
    await until(() => r.approvals().length === 1);
    r.engine.handle({ cmd: "approve", id: r.approvals()[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    r.send("npm test -- --bail", "ask");
    await r.engine.idle();
    expect(r.approvals()).toHaveLength(1);
    expect(r.results()).toEqual(["ran: npm test", "ran: npm test -- --bail"]);
    r.send("curl https://x.example", "ask");
    await until(() => r.approvals().length === 2);
    r.engine.handle({ cmd: "approve", id: r.approvals()[1]!.id, optionId: "deny" });
    await r.engine.idle();
    r.engine.close();
  });

  test("Edits lets a file edit through and asks about a command; Auto asks only about what cannot be undone", async () => {
    const edits = rig();
    edits.send("mkdir out", "edits");
    await edits.engine.idle();
    expect(edits.approvals()).toHaveLength(0);
    edits.send("npm test", "edits");
    await until(() => edits.approvals().length === 1);
    await edits.answer("allow");
    await edits.engine.idle();
    edits.engine.close();
    const auto = rig();
    auto.send("npm test", "auto");
    await auto.engine.idle();
    expect(auto.approvals()).toHaveLength(0);
    auto.send("git push --force origin main", "auto");
    await until(() => auto.approvals().length === 1);
    expect(auto.approvals()[0]!.risk).toContain("history");
    await auto.answer("deny");
    await auto.engine.idle();
    expect(auto.results()).toEqual(["ran: npm test", "The user denied this action."]);
    auto.engine.close();
  });

  test("Bypass and Plan ask nothing and say nothing (the program's own mode stays in charge), but what is never done is stopped in every mode", async () => {
    for (const mode of ["bypass", "plan"] as const) {
      const r = rig();
      r.send("git push --force origin main", mode);
      await r.engine.idle();
      expect(r.approvals()).toHaveLength(0);
      expect(r.results()).toEqual(["ran: git push --force origin main"]);
      r.send("rm -rf ~", mode);
      await r.engine.idle();
      expect(r.results().at(-1)).toContain("navvied never does this");
      r.engine.close();
    }
  });

  test("a question still waiting when the turn is stopped is answered no, so the program is not left waiting", async () => {
    const r = rig();
    r.send("npm test", "ask");
    await until(() => r.approvals().length === 1);
    r.engine.handle({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.results()).toEqual(["The user denied this action."]);
    r.engine.close();
  });
});

describe("a program is not started unless its guard is seen to work", () => {
  const broken = (code: number, message: string) => { const file = join(mkdtempSync(join(tmpdir(), "navvied-guard-stub-")), "stub.ts"); dirs.push(join(file, "..")); writeFileSync(file, `process.stderr.write(${JSON.stringify(message)}); process.exit(${code});`); return `bun "${file}"`; };

  test("a guard that cannot start: nothing is run, the person is told why, and the program was never started", async () => {
    const r = rig(`bun "${join(tmpdir(), "no-such-folder", "stub.ts")}"`);
    r.send("npm test", "bypass");
    await r.engine.idle();
    expect(r.events.find((e): e is Extract<EngineEvent, { ev: "error" }> => e.ev === "error")!.msg).toMatch(/^navvied's guard could not be started for this program, so nothing was run: /);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "error" });
    expect(r.results()).toEqual([]);
    expect(r.events.some((e) => e.ev === "phase")).toBe(false);
    r.engine.close();
  });

  test("a guard that ends with an error says its own last words; one that answers with something is no guard either", async () => {
    const failing = rig(broken(1, "cannot find the program navvied\n"));
    failing.send("npm test", "auto");
    await failing.engine.idle();
    expect(failing.events.find((e): e is Extract<EngineEvent, { ev: "error" }> => e.ev === "error")!.msg).toContain("cannot find the program navvied");
    expect(failing.results()).toEqual([]);
    failing.engine.close();
    const noisy = rig(`bun -e "console.log('hello')"`);
    noisy.send("npm test", "ask");
    await noisy.engine.idle();
    expect(noisy.events.some((e) => e.ev === "error")).toBe(true);
    expect(noisy.results()).toEqual([]);
    noisy.engine.close();
  });

  test("a guard that works is looked at once: the program starts, the probe asks nobody, and the next message does not look again", async () => {
    const r = rig();
    r.send("echo one", "bypass");
    await r.engine.idle();
    r.send("echo two", "bypass");
    await r.engine.idle();
    expect(r.approvals()).toHaveLength(0);
    expect(r.results()).toEqual(["ran: echo one", "ran: echo two"]);
    r.engine.close();
  });

  test("when the program's hook cannot run, its default mode refuses the tool, and only turned-off prompts let it run (what the program does, as the fake models it)", async () => {
    // The guard works when the engine looks, then stops working: the program is started with it broken.
    const dir = mkdtempSync(join(tmpdir(), "navvied-guard-gone-")); dirs.push(dir);
    const stub = join(dir, "stub.ts");
    writeFileSync(stub, readFileSync(STUB, "utf8").replace("../src/index.ts", join(import.meta.dir, "../src/index.ts")));
    const events: EngineEvent[] = [];
    const engine = new StreamEngine({ command: "bun", args: [FAKE], cwd: dir, window: 100_000, emit: (e) => events.push(e), heartbeatMs: 0, guard: `bun "${stub}"` });
    engine.handle({ cmd: "prompt", text: "echo warm", mode: "bypass" } as Command);
    await engine.idle();
    rmSync(stub);
    const results = (): string[] => events.filter((e): e is Tool => e.ev === "tool" && e.status !== "running").map((e) => e.output ?? "");
    engine.handle({ cmd: "prompt", text: "run bash: rm -rf ~", mode: "bypass" } as Command);
    await engine.idle();
    // Bypass turns the program's own questions off, so a hook that cannot run leaves nothing in the way: the engine's check above is what stands against that.
    expect(results().at(-1)).toBe("ran: rm -rf ~");
    engine.handle({ cmd: "prompt", text: "run bash: rm -rf ~", mode: "auto" } as Command);
    await until(() => events.filter((e) => e.ev === "done").length === 3);
    expect(results().at(-1)).toBe("Permission to use Bash has been denied.");
    engine.close();
  });
});

describe("the channel fails closed", () => {
  const call = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/" });
  test("with no engine to ask, with a wrong token, and with an engine that is gone, nothing is allowed and the model is told why", async () => {
    const none = await askEngine({}, call);
    expect(none).toMatchObject({ code: 2, stdout: "" });
    expect(none.stderr).toContain("cannot be asked");
    const server = new AskServer(async () => ({ decision: "allow" }));
    const env = server.listen();
    expect((await askEngine({ ...env, [ASK_TOKEN]: "wrong" }, call)).code).toBe(2);
    expect(await askEngine(env, call)).toMatchObject({ code: 0 });
    server.close();
    const gone = await askEngine({ [ASK_ADDRESS]: env[ASK_ADDRESS], [ASK_TOKEN]: env[ASK_TOKEN] }, call);
    expect(gone.code).toBe(2);
    expect(gone.stderr).toContain("did not answer");
    expect((await askEngine(env, "not json")).code).toBe(2);
  });
  test("an engine that fails while deciding does not let the tool run", async () => {
    const server = new AskServer(async () => { throw new Error("boom"); });
    const answer = await askEngine(server.listen(), call);
    expect(answer.code).toBe(2);
    server.close();
  });
});
