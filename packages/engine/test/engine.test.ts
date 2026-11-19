import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { FileSessionStore, MemorySessionStore } from "../src/index.ts";
import type { Message, ModelRequest } from "../src/types.ts";
import { cleanupAll, prompt, rig, until, wait, type Step } from "./helpers.ts";

afterAll(cleanupAll);

const lastUser = (req: ModelRequest): string => {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  return "";
};
const lastIsTool = (req: ModelRequest) => req.messages.at(-1)?.role === "tool";
const toolText = (req: ModelRequest) => String(req.messages.at(-1)?.content ?? "");
const names = (req: ModelRequest) => req.tools.map((t) => t.name);

/** Calls the tool a prompt keyword asks for (on f.txt in the working directory), then answers with what the tool returned. */
const tooling = (req: ModelRequest, _n: number, dir: string): Step => {
  if (lastIsTool(req)) return { text: `done: ${toolText(req).replace(/\s+/g, " ").slice(0, 80)}` };
  const u = lastUser(req), f = join(dir, "f.txt");
  if (/\bwrite\b/.test(u)) return { calls: [{ name: "Write", args: { file_path: f, content: "alpha\nbeta\n" } }] };
  if (/\bedit\b/.test(u)) return { calls: [{ name: "Edit", args: { file_path: f, old_string: "beta", new_string: "gamma" } }] };
  if (/\bread\b/.test(u)) return { calls: [{ name: "Read", args: { file_path: f } }] };
  if (/\bbash\b/.test(u)) return { calls: [{ name: "Bash", args: { command: "echo from-shell && pwd" } }] };
  return { text: "ok" };
};

describe("startup", () => {
  test("announces the session and what it can do", () => {
    const r = rig(() => ({ text: "x" }));
    expect(r.of("session")[0]?.id).toBe(r.engine.sessionId);
    expect(r.of("caps")[0]).toMatchObject({ steer: true, modes: ["ask", "edits", "plan", "auto", "bypass"], defaultMode: "auto", compact: true });
    r.cleanup();
  });
});

describe("echoing the prompt", () => {
  test("a prompt without a qid is not echoed, a re-sent qid is echoed once, and images are only counted", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("anonymous"));
    await r.turn(prompt("again", { qid: "same" }));
    await r.turn(prompt("again", { qid: "same" }));
    await r.turn({ cmd: "prompt", text: "look", qid: "pic", images: [{ mime: "image/png", data: "AAAA" }] });
    expect(r.of("user").map((e) => e.qid)).toEqual(["same", "pic"]);
    expect(r.of("user").find((e) => e.qid === "pic")).toEqual({ ev: "user", qid: "pic", text: "look", images: 1 });
    r.cleanup();
  });
});

describe("a small model", () => {
  const names = (r: ReturnType<typeof rig>, i = 0): string[] => r.provider.requests[i]!.tools.map((t) => t.name);

  test("is offered only the tools it needs, a shorter prompt, and the web tool only when an address is mentioned", async () => {
    const small = rig(() => ({ text: "hi" }), { window: 32_768 });
    await small.turn(prompt("say hi"));
    expect(names(small)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    expect(small.provider.requests[0]!.system).toContain("Answer questions and chat in plain text, directly");
    expect(small.provider.requests[0]!.system.length).toBeLessThan(700);
    await small.turn(prompt("what is on https://example.com/docs ?"));
    expect(names(small, 1)).toContain("WebFetch");
    expect(names(small, 1)).not.toContain("TodoWrite");
    small.cleanup();
  });

  test("a model with a large window keeps every tool and the full prompt", async () => {
    const large = rig(() => ({ text: "hi" }));
    await large.turn(prompt("say hi"));
    expect(names(large)).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Remember", "TodoWrite"]);
    expect(large.provider.requests[0]!.system).toContain("careful senior engineer");
    large.cleanup();
  });

  test("plan mode still offers only reading tools and the way to hand in the plan", async () => {
    const r = rig(() => ({ text: "ok" }), { window: 32_768 });
    await r.turn(prompt("plan it", { mode: "plan" }));
    expect(names(r)).toEqual(["Read", "Glob", "Grep", "ExitPlanMode"]);
    r.cleanup();
  });

  test("the standing instructions are still passed on", async () => {
    const r = rig(() => ({ text: "ok" }), { window: 32_768, instructions: () => "Always use tabs." });
    await r.turn(prompt("hello"));
    expect(r.provider.requests[0]!.system).toContain("Always use tabs.");
    r.cleanup();
  });
});

describe("a plain turn", () => {
  test("streams text, confirms the prompt, reports usage, finishes", async () => {
    const r = rig(() => ({ text: "all done here" }));
    const t = await r.turn(prompt("hello", { qid: "q-1" }));
    expect(t.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("all done here");
    expect(t.some((e) => e.ev === "taken" && e.qid === "q-1")).toBe(true);
    const order = t.map((e) => e.ev);
    expect(t.find((e) => e.ev === "user")).toEqual({ ev: "user", qid: "q-1", text: "hello" });
    expect(order.indexOf("user")).toBe(order.indexOf("taken") - 1);
    expect(t.find((e) => e.ev === "usage")).toMatchObject({ win: 100_000 });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });

  test("images become message parts", async () => {
    const r = rig(() => ({ text: "seen" }));
    await r.turn(prompt("what is this", { images: [{ mime: "image/png", data: "AAAA" }] }));
    const content = r.provider.requests[0]?.messages[0]?.content;
    expect(content).toEqual([{ type: "text", text: "what is this" }, { type: "image", mime: "image/png", data: "AAAA" }]);
    r.cleanup();
  });

  test("effort and persona reach the model request; the plan note only appears in plan mode", async () => {
    const r = rig(() => ({ text: "ok" }), { persona: "You are Atlas." });
    await r.turn(prompt("hi", { effort: "high" }));
    await r.turn(prompt("hi again", { mode: "plan" }));
    const [a, b] = r.provider.requests;
    expect(a?.effort).toBe("high");
    expect(a?.system).toContain("You are Atlas.");
    expect(a?.system).not.toContain("PLAN MODE");
    expect(b?.system).toContain("PLAN MODE");
    r.cleanup();
  });

  test("a failing provider produces an error and a done(error); the engine stays usable", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? { fail: "upstream exploded" } : { text: "recovered" }));
    const t = await r.turn(prompt("one"));
    expect(t.find((e) => e.ev === "error")).toMatchObject({ msg: "upstream exploded" });
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
    const t2 = await r.turn(prompt("two"));
    expect(t2.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.text()).toContain("recovered");
    r.cleanup();
  });
});

describe("tools through the loop", () => {
  test("Write → Edit → Read → Bash: files change, cards go running → done with one id, the model sees results", async () => {
    const r = rig(tooling);
    const f = join(r.dir, "f.txt");

    let t = await r.turn(prompt("write it"));
    expect(readFileSync(f, "utf8")).toBe("alpha\nbeta\n");
    const cards = t.filter((e): e is Extract<EngineEvent, { ev: "tool" }> => e.ev === "tool" && e.name === "Write");
    expect(cards.map((c) => c.status)).toEqual(["running", "running", "done"]); // announced, then with input, then the result
    expect(new Set(cards.map((c) => c.id)).size).toBe(1);
    expect(cards.find((c) => c.input)?.input).toMatchObject({ file_path: f });
    expect(r.text()).toContain("done: Created");

    await r.turn(prompt("edit it"));
    expect(readFileSync(f, "utf8")).toBe("alpha\ngamma\n");

    t = await r.turn(prompt("read it"));
    expect(t.some((e) => e.ev === "tool" && e.name === "Read" && e.status === "done" && /1\talpha/.test(e.output ?? "") && /2\tgamma/.test(e.output ?? ""))).toBe(true);

    t = await r.turn(prompt("bash it"));
    expect(t.some((e) => e.ev === "tool" && e.name === "Bash" && e.status === "done" && /from-shell/.test(e.output ?? "") && /\[exit 0\]/.test(e.output ?? ""))).toBe(true);
    r.cleanup();
  });

  test("an unknown tool and broken JSON arguments become tool errors the model can react to", async () => {
    let n = 0;
    const r = rig((req) => {
      if (lastIsTool(req)) return { text: "handled" };
      n++;
      return n === 1 ? { calls: [{ name: "Teleport", args: {} }] } : { calls: [{ name: "Read", rawArgs: "{not json" }] };
    });
    let t = await r.turn(prompt("go"));
    expect(t.some((e) => e.ev === "tool" && e.name === "Teleport" && e.status === "error" && /there is no tool/.test(e.output ?? ""))).toBe(true);
    t = await r.turn(prompt("again"));
    expect(t.some((e) => e.ev === "tool" && e.name === "Read" && e.status === "error" && /must be a JSON object such as \{"file_path": "\.\.\."\}/.test(e.output ?? ""))).toBe(true);
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });

  test("a runaway loop stops at the step limit with a clear message", async () => {
    const r = rig(() => ({ calls: [{ name: "TodoWrite", args: { todos: [] } }] }), { maxSteps: 5 });
    const t = await r.turn(prompt("loop"));
    expect(t.some((e) => e.ev === "error" && /Stopped after 5 steps/.test(e.msg))).toBe(true);
    expect(r.provider.requests.length).toBe(5);
    r.cleanup();
  });
});

describe("permission modes", () => {
  test("ask: a write waits for approval; deny leaves the file alone and tells the model", async () => {
    const r = rig(tooling);
    r.send(prompt("write it", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    const card = r.of("approval")[0]!;
    expect(card.title).toMatch(/^Write file: /);
    expect(card.options.map((o) => o.optionId)).toEqual(["allow", "allow_always", "deny"]);
    expect(card.options[1]!.name).toBe("Allow, and do not ask again for changes in the project folder");
    expect(card.change).toEqual({ tool: "Write", file: join(r.dir, "f.txt"), content: "alpha\nbeta\n" });
    expect(existsSync(join(r.dir, "f.txt"))).toBe(false);
    r.send({ cmd: "approve", id: card.id, optionId: "deny" });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "f.txt"))).toBe(false);
    expect(r.events.some((e) => e.ev === "tool" && e.status === "error" && /denied/.test(e.output ?? ""))).toBe(true);
    expect(r.text()).toContain("denied");

    r.send(prompt("write it", { mode: "ask" }));
    await until(() => r.of("approval").length === 2);
    r.send({ cmd: "approve", id: r.of("approval")[1]!.id, optionId: "allow" });
    await r.engine.idle();
    expect(readFileSync(join(r.dir, "f.txt"), "utf8")).toBe("alpha\nbeta\n");
    r.cleanup();
  });

  test("ask: 'do not ask again' covers that kind of change for the rest of the session, and nothing else", async () => {
    const r = rig(tooling);
    r.send(prompt("write it", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    expect(readFileSync(join(r.dir, "f.txt"), "utf8")).toBe("alpha\nbeta\n");
    r.send(prompt("write it", { mode: "ask" }));
    await r.engine.idle();
    expect(r.of("approval")).toHaveLength(1);
    r.send(prompt("bash it", { mode: "ask" }));
    await until(() => r.of("approval").length === 2);
    expect(r.of("approval")[1]!.options[1]!.name).toBe("Allow, and do not ask again for echo commands");
    r.send({ cmd: "approve", id: r.of("approval")[1]!.id, optionId: "deny" });
    await r.engine.idle();
    r.cleanup();
  });

  test("ask: read-only tools never ask; an answer to an unknown id is ignored", async () => {
    const r = rig(tooling);
    writeFileSync(join(r.dir, "f.txt"), "x\n");
    await r.turn(prompt("read it", { mode: "ask" }));
    expect(r.of("approval").length).toBe(0);
    r.send({ cmd: "approve", id: "nope", optionId: "allow" });
    await r.engine.idle();
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    r.cleanup();
  });

  test("plan: write-capable tools are never offered; the plan is streamed and proposed; no internal card leaks", async () => {
    const r = rig((req) => (names(req).includes("ExitPlanMode") && !lastIsTool(req)
      ? { text: "Researched.", calls: [{ name: "ExitPlanMode", args: { plan: "1. First\n2. Second" } }] }
      : { text: "ok" }));
    const t = await r.turn(prompt("plan it", { mode: "plan" }));
    for (const req of r.provider.requests) {
      expect(names(req)).toContain("Read");
      for (const banned of ["Write", "Edit", "Bash"]) expect(names(req)).not.toContain(banned);
    }
    expect(t.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toContain("1. First\n2. Second");
    expect(t.some((e) => e.ev === "plan_proposal")).toBe(true);
    expect(t.some((e) => e.ev === "tool" && e.name === "ExitPlanMode")).toBe(false);
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });

    await r.turn(prompt("now do it", { mode: "auto" }));
    const last = r.provider.requests.at(-1)!;
    expect(names(last)).toContain("Write");
    expect(names(last)).not.toContain("ExitPlanMode");
    r.cleanup();
  });

  test("plan: a model that just answers in text still gets a proposal", async () => {
    const r = rig(() => ({ text: "Here is my plan in prose." }));
    const t = await r.turn(prompt("plan", { mode: "plan" }));
    expect(t.some((e) => e.ev === "plan_proposal")).toBe(true);
    r.cleanup();
  });

  test("plan: a forced write call is refused as unknown", async () => {
    let n = 0;
    const r = rig((req) => (lastIsTool(req) ? { text: "ok" } : n++ === 0 ? { calls: [{ name: "Bash", args: { command: "touch hacked" } }] } : { text: "ok" }));
    const t = await r.turn(prompt("go", { mode: "plan" }));
    expect(t.some((e) => e.ev === "tool" && e.name === "Bash" && e.status === "error" && /plan mode only allows reading/.test(e.output ?? ""))).toBe(true);
    expect(existsSync(join(r.dir, "hacked"))).toBe(false);
    r.cleanup();
  });
});

describe("steering and queueing", () => {
  test("a message sent during a tool step is folded into the same turn", async () => {
    const r = rig((req) => {
      if (lastIsTool(req) || lastUser(req).includes("extra")) return { text: "folded" };
      return { calls: [{ name: "Bash", args: { command: "sleep 0.4" } }] };
    });
    r.send(prompt("start"));
    await until(() => r.of("tool").some((e) => e.name === "Bash" && e.input !== undefined));
    r.send(prompt("extra thing", { qid: "q-steer" }));
    await r.engine.idle();
    expect(r.of("taken").some((e) => e.qid === "q-steer")).toBe(true);
    expect(r.of("user").find((e) => e.qid === "q-steer")).toMatchObject({ text: "extra thing" });
    expect(r.of("done").length).toBe(1);
    expect(r.provider.requests.some((q) => lastUser(q).includes("extra thing"))).toBe(true);
    r.cleanup();
  });

  test("a message sent while the reply streams runs as the next turn, with one done at the end", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? { text: "first reply", delayMs: 250 } : { text: "second reply" }));
    r.send(prompt("one"));
    await wait(80);
    r.send(prompt("two", { qid: "q2" }));
    await r.engine.idle();
    expect(r.text()).toContain("first reply");
    expect(r.text()).toContain("second reply");
    expect(r.of("taken").some((e) => e.qid === "q2")).toBe(true);
    expect(r.of("done").length).toBe(1);
    r.cleanup();
  });
});

describe("cancel", () => {
  test("kills a running command within seconds and reports cancelled", async () => {
    const r = rig(() => ({ calls: [{ name: "Bash", args: { command: "sleep 30; echo finished" } }] }));
    r.send(prompt("slow"));
    await until(() => r.of("tool").some((e) => e.name === "Bash" && e.input !== undefined));
    const t0 = Date.now();
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    r.cleanup();
  });

  test("aborts a streaming reply, drops the queue, and the engine is usable afterwards", async () => {
    let n = 0;
    const r = rig(() => (n++ === 0 ? { text: "thinking slowly", delayMs: 5000 } : { text: "back" }));
    r.send(prompt("slow"));
    await wait(60);
    r.send(prompt("queued"));
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    const t = await r.turn(prompt("again"));
    expect(t.at(-1)).toEqual({ ev: "done", stop: "end_turn" });
    expect(r.provider.requests.length).toBe(2); // the queued message never ran
    r.cleanup();
  });

  test("cancelling while an approval is waiting denies it and unwinds", async () => {
    const r = rig(tooling);
    r.send(prompt("write it", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "f.txt"))).toBe(false);
    expect(r.events.at(-1)).toEqual({ ev: "done", stop: "cancelled" });
    r.cleanup();
  });

  test("cancel when idle is a no-op", () => {
    const r = rig(() => ({ text: "x" }));
    const before = r.events.length;
    r.send({ cmd: "cancel" });
    expect(r.events.length).toBe(before);
    r.cleanup();
  });
});

describe("context and compaction", () => {
  const long = "x".repeat(600);
  test("manual compact summarises older turns, lowers usage, and the next request is shorter", async () => {
    const r = rig(() => ({ text: "answer" }));
    for (let i = 0; i < 4; i++) await r.turn(prompt(`question ${i} ${long}`));
    const before = r.of("usage").at(-1)!.ctx;
    const t = await r.turn({ cmd: "compact" });
    expect(t.some((e) => e.ev === "phase" && e.name === "compacting")).toBe(true);
    expect(t.filter((e) => e.ev === "phase").at(-1)).toMatchObject({ name: "" });
    expect(t.find((e) => e.ev === "usage")!).toMatchObject({ out: 0 });
    expect((t.find((e) => e.ev === "usage") as { ctx: number }).ctx).toBeLessThan(before);
    expect(t.at(-1)).toEqual({ ev: "done", stop: "compacted" });
    expect(r.provider.summaries.length).toBe(1);
    await r.turn(prompt("after"));
    const head = r.provider.requests.at(-1)!.messages[0]!;
    expect(String(head.content)).toContain("[Summary of the earlier conversation]");
    r.cleanup();
  });

  test("compacting a short conversation says so instead of failing silently", async () => {
    const r = rig(() => ({ text: "answer" }));
    await r.turn(prompt("hi"));
    const t = await r.turn({ cmd: "compact" });
    expect(t.some((e) => e.ev === "error" && /Nothing to compact/.test(e.msg))).toBe(true);
    expect(t.at(-1)).toEqual({ ev: "done", stop: "error" });
    r.cleanup();
  });

  test("a failing summary keeps the conversation and reports why", async () => {
    const r = rig(() => ({ text: "answer" }));
    for (let i = 0; i < 4; i++) await r.turn(prompt(`q${i} ${long}`));
    r.provider.summaryFails = true;
    const t = await r.turn({ cmd: "compact" });
    expect(t.some((e) => e.ev === "error" && /Couldn't compact: summary unavailable/.test(e.msg))).toBe(true);
    await r.turn(prompt("still works"));
    expect(r.provider.requests.at(-1)!.messages.length).toBeGreaterThan(8);
    r.cleanup();
  });

  test("compaction runs by itself when the window fills up", async () => {
    const r = rig(() => ({ text: "answer" }), { window: 1500 });
    for (let i = 0; i < 6; i++) await r.turn(prompt(`filler ${i} ${long.repeat(4)}`));
    expect(r.provider.summaries.length).toBeGreaterThan(0);
    expect(r.of("phase").some((e) => e.name === "compacting")).toBe(true);
    r.cleanup();
  });

  test("a compact command during a turn is refused", async () => {
    const r = rig(() => ({ text: "slow", delayMs: 300 }));
    r.send(prompt("go"));
    await wait(30);
    r.send({ cmd: "compact" });
    await r.engine.idle();
    expect(r.of("error").some((e) => /Wait for the current turn/.test(e.msg))).toBe(true);
    r.cleanup();
  });
});

describe("sessions", () => {
  test("a saved session resumes with its history", async () => {
    const store = new MemorySessionStore();
    const a = rig(() => ({ text: "first answer" }), { store });
    await a.turn(prompt("remember the number 42"));
    const id = a.engine.sessionId;
    a.cleanup();
    const b = rig(() => ({ text: "second answer" }), { store, sessionId: id });
    expect(b.engine.sessionId).toBe(id);
    expect(b.of("usage")[0]!.ctx).toBeGreaterThan(0);
    await b.turn(prompt("what number?"));
    const msgs = b.provider.requests[0]!.messages;
    expect(JSON.stringify(msgs)).toContain("remember the number 42");
    b.cleanup();
  });

  test("the load command switches to another saved session; unknown ids are reported", async () => {
    const store = new MemorySessionStore();
    const a = rig(() => ({ text: "from a" }), { store });
    await a.turn(prompt("alpha topic"));
    const b = rig(() => ({ text: "from b" }), { store });
    let t = await b.turn({ cmd: "load", id: a.engine.sessionId });
    expect(t.some((e) => e.ev === "loaded" && e.id === a.engine.sessionId)).toBe(true);
    await b.turn(prompt("continue"));
    expect(JSON.stringify(b.provider.requests[0]!.messages)).toContain("alpha topic");
    t = await b.turn({ cmd: "load", id: "does-not-exist" });
    expect(t.some((e) => e.ev === "error" && /not found/.test(e.msg))).toBe(true);
    a.cleanup(); b.cleanup();
  });

  test("file store: round trip, atomic file, unsafe ids rejected", () => {
    const r = rig(() => ({ text: "x" }));
    const store = new FileSessionStore(join(r.dir, "sessions"));
    const msgs: Message[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    store.save("abc-123", msgs);
    expect(store.load("abc-123")).toEqual(msgs);
    expect(store.load("missing")).toBeNull();
    expect(() => store.save("../escape", msgs)).toThrow(/invalid session id/);
    expect(store.load("../escape")).toBeNull();
    r.cleanup();
  });
});

describe("saved sessions can be listed and continued from any window", () => {
  test("the sessions command lists them newest first with a title from the first question", async () => {
    const r = rig(() => ({ text: "ok" }));
    const store = new FileSessionStore(join(r.dir, "sessions"));
    store.save("old", [{ role: "user", content: "  how do   I\nsort a list?  " }, { role: "assistant", content: "use sort" }]);
    await wait(15);
    store.save("new", [{ role: "user", content: [{ type: "text", text: "x".repeat(100) }] }]);
    store.save("empty", []);
    const e = rig(() => ({ text: "ok" }), { store });
    const t = await e.turn({ cmd: "sessions" });
    const listed = t.find((x) => x.ev === "sessions") as Extract<EngineEvent, { ev: "sessions" }>;
    expect(listed.items.map((i) => i.id)).toEqual(["new", "old"]);
    expect(listed.items[1]).toMatchObject({ title: "how do I sort a list?", messages: 2 });
    expect(listed.items[0]!.title).toHaveLength(60);
    e.cleanup(); r.cleanup();
  });
  test("loading one tells every window its conversation, and the next prompt continues and saves into it", async () => {
    const r = rig(() => ({ text: "ok" }));
    const store = new FileSessionStore(join(r.dir, "sessions"));
    store.save("s1", [{ role: "user", content: "alpha topic" }, { role: "assistant", content: "about alpha", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] }, { role: "tool", toolCallId: "c1", content: "file text" }]);
    const e = rig(() => ({ text: "answer" }), { store });
    const t = await e.turn({ cmd: "load", id: "s1" });
    const loaded = t.find((x) => x.ev === "loaded") as Extract<EngineEvent, { ev: "loaded" }>;
    expect(loaded.items).toEqual([{ k: "user", text: "alpha topic" }, { k: "assistant", text: "about alpha" }, { k: "tool", text: "read_file" }]);
    expect(e.engine.sessionId).toBe("s1");
    await e.turn(prompt("and beta"));
    expect(JSON.stringify(e.provider.requests[0]!.messages)).toContain("alpha topic");
    expect(JSON.stringify(store.load("s1"))).toContain("and beta");
    e.cleanup(); r.cleanup();
  });
});

describe("heartbeat", () => {
  test("alive is emitted while working, not while idle", async () => {
    const r = rig(() => ({ text: "slow", delayMs: 250 }), { heartbeatMs: 40 });
    await wait(120);
    expect(r.of("alive").length).toBe(0);
    await r.turn(prompt("go"));
    expect(r.of("alive").length).toBeGreaterThan(1);
    r.cleanup();
  });
});

test("every event the engine emits is a known protocol event with its required fields", async () => {
  const r = rig(tooling);
  await r.turn(prompt("write it", { qid: "q" }));
  await r.turn(prompt("bash it", { mode: "plan" }));
  const known = new Set(["session", "loaded", "caps", "user", "taken", "text", "thought", "tool", "plan", "usage", "approval", "plan_proposal", "phase", "alive", "done", "error", "thought_end", "job", "notice"]);
  expect(r.events.every((e) => known.has(e.ev))).toBe(true);
  expect(r.events.filter((e) => e.ev === "done").length).toBe(2);
  r.cleanup();
});

describe("what the page needs to draw a group", () => {
  test("the turn's tokens add up call by call and start again with the next turn", async () => {
    const r = rig((req) => (lastIsTool(req) ? { text: "done" } : { calls: [{ name: "Bash", args: { command: "echo hi" } }] }));
    r.send(prompt("go", { qid: "q1" }));
    await r.engine.idle();
    const usage = r.of("usage").filter((e) => e.turn);
    expect(usage.map((e) => e.turn!.calls)).toEqual([1, 2]);
    expect(usage[1]!.turn!.out).toBe(20);
    expect(usage[1]!.turn!.in).toBeGreaterThan(usage[0]!.turn!.in);
    r.send(prompt("again", { qid: "q2" }));
    await r.engine.idle();
    expect(r.of("usage").filter((e) => e.turn).slice(-2).map((e) => e.turn!.calls)).toEqual([1, 2]); // a new turn starts from zero
    r.cleanup();
  });

  test("a task list says which turn and which step wrote it", async () => {
    const r = rig((req) => (lastIsTool(req) ? { text: "ok" } : { calls: [{ name: "TodoWrite", args: { todos: [{ content: "one", status: "pending" }] } }] }));
    r.send(prompt("plan it", { qid: "q-plan" }));
    await r.engine.idle();
    const plan = r.of("plan")[0]!;
    expect(plan.qid).toBe("q-plan");
    expect(r.of("tool").some((e) => e.id === plan.tool && e.name === "TodoWrite")).toBe(true);
    r.cleanup();
  });

  test("a message sent while a step waits its turn redirects it: the waiting steps are not run and say so", async () => {
    const r = rig((req) => {
      if (lastIsTool(req) || lastUser(req).includes("instead")) return { text: "changed course" };
      return { calls: [{ name: "Bash", args: { command: "sleep 0.4" } }, { name: "Bash", args: { command: "echo never" } }] };
    });
    r.send(prompt("start"));
    await until(() => r.of("tool").some((e) => e.name === "Bash" && e.input !== undefined && e.status === "running" && !e.queued));
    r.send(prompt("do this instead", { qid: "q-redirect" }));
    await r.engine.idle();
    const ended = r.of("tool").filter((e) => e.status !== "running");
    expect(ended.filter((e) => e.outcome === "redirected").length).toBe(1);
    expect(JSON.stringify(r.of("tool"))).not.toContain("never\\n");
    expect(r.of("taken").some((e) => e.qid === "q-redirect")).toBe(true);
    expect(r.of("done").length).toBe(1);
    r.cleanup();
  });
});

