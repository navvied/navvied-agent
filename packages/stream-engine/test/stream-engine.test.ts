import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, EngineEvent } from "@navvied/protocol";
import { StreamEngine, type StreamEngineOptions } from "../src/index.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const FAKE = join(import.meta.dir, "fake-agent.ts");
const dirs: string[] = [];
afterAll(hook("stream-engine removes what it made", async () => { await removeTrees(dirs); }), HOOK_MS);

function rig(opts: Partial<StreamEngineOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "navvied-stream-")); dirs.push(dir);
  const log = join(dir, "argv.log");
  const events: EngineEvent[] = [];
  const engine = new StreamEngine({
    command: "bun", args: [FAKE], cwd: dir, window: 100_000, emit: (e) => events.push(e), heartbeatMs: 0, env: { FAKE_ARGV_LOG: log }, ...opts,
  });
  const starts = (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const turn = async (cmd: Command, ms = 10_000): Promise<EngineEvent[]> => {
    const from = events.length;
    engine.handle(cmd);
    await Promise.race([engine.idle(), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), ms))]);
    return events.slice(from);
  };
  const of = <K extends EngineEvent["ev"]>(ev: K, from = 0) => events.slice(from).filter((e): e is Extract<EngineEvent, { ev: K }> => e.ev === ev);
  return { engine, events, turn, of, starts, dir };
}
const say = (text: string, extra: Record<string, unknown> = {}): Command => ({ cmd: "prompt", text, ...extra } as Command);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000) { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("condition not met"); await wait(15); } }

describe("starting", () => {
  test("the person is told the program is starting until it says something, and then it is thinking", async () => {
    const r = rig();
    const events = await r.turn(say("hello", { qid: "q1" }));
    const names = events.map((e) => (e.ev === "phase" ? `phase:${e.name || "clear"}` : e.ev));
    const starting = names.indexOf("phase:starting"), clear = names.indexOf("phase:clear"), taken = names.indexOf("taken");
    expect(starting).toBeGreaterThanOrEqual(0);
    // Every window is shown the message as waiting from the moment it was received, not only when the program echoes it.
    expect(names.indexOf("queued")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("queued")).toBeLessThan(names.indexOf("taken"));
    expect(clear).toBeGreaterThan(starting);
    expect(taken).toBeGreaterThan(starting);
    // Only once per start of the program: the next message finds it running and says nothing.
    const again = await r.turn(say("again", { qid: "q2" }));
    expect(again.some((e) => e.ev === "phase" && e.name === "starting")).toBe(false);
    r.engine.close();
  });
});

describe("a plain turn", () => {
  test("announces its capabilities up front: auto and plan, no compact, steering", () => {
    const r = rig();
    expect(r.of("caps")[0]).toEqual({ ev: "caps", steer: true, modes: ["auto", "plan"], defaultMode: "auto", compact: false });
    expect(r.of("session")).toEqual([]); // an external agent only reports its session after the first message
    r.engine.close();
  });

  test("starts the agent lazily with the right flags, shows the text exactly once, reports usage and the session", async () => {
    const r = rig({ model: "some-model" });
    const t = await r.turn(say("hello", { qid: "q-1" }));
    expect(r.starts()).toHaveLength(1);
    const argv = r.starts()[0]!;
    expect(argv).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "some-model"]));
    expect(argv).not.toContain("--resume");
    expect(t.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("Hello");
    expect(t.some((e) => e.ev === "thought")).toBe(true);
    expect(t.some((e) => e.ev === "taken" && e.qid === "q-1")).toBe(true);
    const names = t.map((e) => e.ev);
    expect(t.find((e) => e.ev === "user")).toMatchObject({ qid: "q-1" });
    expect(names.indexOf("user")).toBe(names.indexOf("taken") - 1);
    expect(t.find((e) => e.ev === "usage")).toEqual({ ev: "usage", ctx: 110, win: 100_000, out: 5 });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.of("session")).toHaveLength(1);
    expect(r.engine.sessionId).toBe(r.of("session")[0]!.id);
    r.engine.close();
  });

  test("a second turn reuses the same process", async () => {
    const r = rig();
    await r.turn(say("hello"));
    await r.turn(say("hello again"));
    expect(r.starts()).toHaveLength(1);
    expect(r.of("done")).toHaveLength(2);
    r.engine.close();
  });

  test("continuing a session announces it at once and resumes the agent's session", async () => {
    const r = rig({ sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(r.of("session")[0]).toEqual({ ev: "session", id: "11111111-1111-4111-8111-111111111111" });
    await r.turn(say("hello"));
    const argv = r.starts()[0]!;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("11111111-1111-4111-8111-111111111111");
    r.engine.close();
  });

  test("garbage on the agent's stdout is ignored", async () => {
    const r = rig();
    const t = await r.turn(say("hello")); // the fake prints a non-JSON warning first
    expect(t.some((e) => e.ev === "error")).toBe(false);
    r.engine.close();
  });
});

describe("tools", () => {
  test("a tool call shows as one card: started, with input, with its result", async () => {
    const r = rig();
    const t = await r.turn(say("run a tool"));
    const cards = t.filter((e): e is Extract<EngineEvent, { ev: "tool" }> => e.ev === "tool");
    expect(cards.map((c) => c.status)).toEqual(["running", "running", "running", "done"]); // started, writing, with input, result
    expect(cards.map((c) => c.progress)).toEqual([0, 11, undefined, undefined]);
    expect(new Set(cards.map((c) => c.id)).size).toBe(1);
    expect(cards[2]!.input).toEqual({ command: "ls" });
    expect(cards[3]!.output).toBe("file1\nfile2");
    expect(r.of("text").map((e) => e.text).join("")).toContain("listed");
    r.engine.close();
  });
  test("a sub-agent's step is a child card", async () => {
    const r = rig();
    const t = await r.turn(say("run a sub task"));
    expect(t.filter((e) => e.ev === "tool").every((e) => (e as { parent?: string }).parent === "task1")).toBe(true);
    r.engine.close();
  });
  test("images are sent to the agent as image blocks", async () => {
    const r = rig();
    await r.turn(say("look at this image", { images: [{ mime: "image/png", data: "AAAA" }, { mime: "image/jpeg", data: "BBBB" }] }));
    expect(r.of("text").map((e) => e.text).join("")).toContain("saw 2 image(s)");
    r.engine.close();
  });
});

describe("modes", () => {
  test("plan: the agent runs read-only, and its plan comes back as text plus a proposal (no hidden card)", async () => {
    const r = rig();
    const t = await r.turn(say("plan the work", { mode: "plan" }));
    const argv = r.starts()[0]!;
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(t.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toContain("1. First\n2. Second");
    expect(t.some((e) => e.ev === "plan_proposal")).toBe(true);
    expect(t.some((e) => e.ev === "tool")).toBe(false);
    r.engine.close();
  });

  test("switching mode between turns restarts the agent on the same session with the new flags", async () => {
    const r = rig();
    await r.turn(say("hello", { mode: "auto" }));
    const sid = r.engine.sessionId;
    await r.turn(say("plan something", { mode: "plan" }));
    const starts = r.starts();
    expect(starts).toHaveLength(2);
    expect(starts[1]![starts[1]!.indexOf("--resume") + 1]).toBe(sid);
    expect(starts[1]).toContain("--permission-mode");
    expect(r.of("plan_proposal")).toHaveLength(1);
    r.engine.close();
  });

  test("changing effort also restarts; repeating the same settings does not", async () => {
    const r = rig();
    await r.turn(say("hello", { effort: "low" }));
    await r.turn(say("hello", { effort: "low" }));
    expect(r.starts()).toHaveLength(1);
    await r.turn(say("hello", { effort: "high" }));
    expect(r.starts()).toHaveLength(2);
    expect(r.starts()[1]![r.starts()[1]!.indexOf("--effort") + 1]).toBe("high");
    r.engine.close();
  });

  test("ask mode is refused with a clear message, and nothing is started", async () => {
    const r = rig();
    const t = await r.turn(say("hello", { mode: "ask" }));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: expect.stringMatching(/can only run in Auto or Plan/) });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
    expect(r.starts()).toHaveLength(0);
    r.engine.close();
  });
});

describe("cancel and failure", () => {
  test("cancel interrupts the agent and reports cancelled; the same process serves the next turn", async () => {
    const r = rig();
    r.engine.handle(say("be slow"));
    await until(() => r.of("taken").length + r.of("session").length > 0);
    const t0 = Date.now();
    r.engine.handle({ cmd: "cancel" });
    await r.engine.idle();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    const t = await r.turn(say("hello"));
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.starts()).toHaveLength(1);
    r.engine.close();
  });

  test("an agent that ignores the interrupt is killed after the grace period; the next turn restarts it on the session", async () => {
    const r = rig({ cancelGraceMs: 300 });
    await r.turn(say("hello"));
    const sid = r.engine.sessionId;
    r.engine.handle(say("stubborn one"));
    await wait(150);
    r.engine.handle({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    expect(r.of("error")).toHaveLength(0); // a requested kill is not an error
    await r.turn(say("hello"));
    expect(r.starts()).toHaveLength(2);
    expect(r.starts()[1]![r.starts()[1]!.indexOf("--resume") + 1]).toBe(sid);
    r.engine.close();
  });

  test("a crash is reported with the agent's own words and the next turn starts a fresh process", async () => {
    const r = rig();
    const t = await r.turn(say("please die"));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: expect.stringMatching(/ended unexpectedly \(exit 3\).*boom: something broke/) });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
    const again = await r.turn(say("hello"));
    expect(again.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.starts()).toHaveLength(2);
    r.engine.close();
  });

  test("an error result and an over-long conversation become clear errors", async () => {
    const r = rig();
    let t = await r.turn(say("fail please"));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: "The agent stopped: too many turns" });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
    t = await r.turn(say("toolong please"));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: expect.stringMatching(/no longer fits/) });
    r.engine.close();
  });

  test("a command that cannot be started is reported, not thrown", async () => {
    const r = rig({ command: "/definitely/not/installed", args: [] });
    const t = await r.turn(say("hello"));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: expect.stringMatching(/Could not start "\/definitely\/not\/installed"/) });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
  });
});

describe("steering", () => {
  test("a message sent mid-turn is taken straight away and the turn finishes once", async () => {
    const r = rig();
    r.engine.handle(say("be slow", { qid: "first" }));
    await until(() => r.of("taken").some((e) => e.qid === "first"));
    r.engine.handle(say("and this too", { qid: "second" }));
    await until(() => r.of("taken").some((e) => e.qid === "second"));
    r.engine.handle({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.of("done")).toHaveLength(1);
    r.engine.close();
  });
});

describe("commands this engine does not offer", () => {
  test("compact and load explain themselves; approve is ignored", () => {
    const r = rig();
    const before = r.events.length;
    r.engine.handle({ cmd: "compact" });
    r.engine.handle({ cmd: "load", id: "x" });
    r.engine.handle({ cmd: "approve", id: "a", optionId: "allow" });
    const added = r.events.slice(before);
    expect(added).toHaveLength(2);
    expect(added.every((e) => e.ev === "error")).toBe(true);
    r.engine.close();
  });
  test("cancel when idle does nothing", () => {
    const r = rig();
    const before = r.events.length;
    r.engine.handle({ cmd: "cancel" });
    expect(r.events.length).toBe(before);
    r.engine.close();
  });
});

describe("shutdown", () => {
  test("close() stops the process and releases anyone waiting", async () => {
    const r = rig();
    r.engine.handle(say("be slow"));
    await wait(200);
    const waiting = r.engine.idle();
    r.engine.close();
    await Promise.race([waiting, wait(2000).then(() => { throw new Error("idle() hung after close"); })]);
  });
});

describe("switching model and effort between turns", () => {
  const MODELS = [{ id: "default", name: "Let it choose" }, { id: "big", name: "Big" }, { id: "fast", name: "Fast" }];
  const EFFORTS = ["low", "medium", "high"] as const;

  test("announces the models with the one in use marked, and the effort levels", () => {
    const r = rig({ models: MODELS, efforts: [...EFFORTS], model: "big" });
    const caps = r.of("caps")[0]!;
    expect(caps.models!.map((m) => [m.id, m.current])).toEqual([["default", false], ["big", true], ["fast", false]]);
    expect(caps.efforts).toEqual([...EFFORTS]);
    r.engine.close();
  });
  test("the next turn restarts the agent on the same session with the new model, and 'default' gives no model flag", async () => {
    const r = rig({ models: MODELS, model: "big" });
    await r.turn(say("one"));
    r.engine.handle({ cmd: "model", id: "fast" });
    expect(r.of("caps").at(-1)!.models!.find((m) => m.current)!.id).toBe("fast");
    await r.turn(say("two"));
    const [first, second] = r.starts();
    expect(first).toEqual(expect.arrayContaining(["--model", "big"]));
    expect(second).toEqual(expect.arrayContaining(["--model", "fast", "--resume"]));
    r.engine.handle({ cmd: "model", id: "default" });
    await r.turn(say("three"));
    expect(r.starts()[2]).not.toContain("--model");
    r.engine.close();
  });
  test("an unknown model, or one when the agent has only one, is refused", () => {
    const r = rig({ models: MODELS });
    r.engine.handle({ cmd: "model", id: "nope" });
    expect(r.of("error").at(-1)!.msg).toBe('There is no model "nope".');
    const single = rig();
    single.engine.handle({ cmd: "model", id: "x" });
    expect(single.of("error").at(-1)!.msg).toBe("This engine has only one model.");
    r.engine.close(); single.engine.close();
  });
  test("effort is passed as the agent's own flag from the next turn, and levels it lacks are refused", async () => {
    const r = rig({ efforts: [...EFFORTS] });
    r.engine.handle({ cmd: "effort", level: "high" });
    expect(r.of("caps").at(-1)!.effort).toBe("high");
    await r.turn(say("think"));
    expect(r.starts()[0]).toEqual(expect.arrayContaining(["--effort", "high"]));
    r.engine.handle({ cmd: "effort", level: "max" });
    expect(r.of("error").at(-1)!.msg).toBe("This model does not have the effort level max.");
    r.engine.handle({ cmd: "effort", level: "auto" });
    await r.turn(say("again"));
    expect(r.starts()[1]).not.toContain("--effort");
    const none = rig();
    none.engine.handle({ cmd: "effort", level: "low" });
    expect(none.of("error").at(-1)!.msg).toBe("This model has no effort setting.");
    r.engine.close(); none.engine.close();
  });
});
