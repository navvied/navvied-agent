import { afterAll, describe, expect, test } from "bun:test";
import type { Effort, ModelInfo } from "@navvied/protocol";
import type { ModelSwitch } from "../src/index.ts";
import { HOOK_MS, ScriptedProvider, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const MODELS: ModelInfo[] = [{ id: "big", name: "Big Model", brand: "one", badge: "MAX" }, { id: "small", name: "Small Model" }];

/** Two scripted models: the second has a small window and no effort setting. */
function pair(opts: { smallWindow?: number } = {}) {
  const second = new ScriptedProvider(() => ({ text: "from the small one" }));
  const efforts: Record<string, Effort[] | undefined> = { big: ["low", "high"], small: undefined };
  const used: string[] = [];
  const switcher: ModelSwitch = {
    models: MODELS, current: "big", efforts: efforts.big,
    use: (id) => {
      used.push(id);
      if (id === "small") return { provider: second, window: opts.smallWindow ?? 32_768 };
      if (id === "big") return { provider: first.provider, window: 100_000, efforts: efforts.big };
      return { error: `There is no model "${id}".` };
    },
  };
  const first = rig(() => ({ text: "from the big one" }), { switcher });
  return { first, second, used, caps: () => first.of("caps").at(-1)! };
}

describe("what the engine says it can do", () => {
  test("lists the models with the one in use marked, and the effort levels of that model", () => {
    const { caps } = pair();
    expect(caps().models).toEqual([{ id: "big", name: "Big Model", brand: "one", badge: "MAX", current: true }, { id: "small", name: "Small Model", current: false }]);
    expect(caps().efforts).toEqual(["low", "high"]);
    expect(caps().effort).toBeUndefined();
  });
  test("an engine with one model lists none and refuses to switch", async () => {
    const r = rig(() => ({ text: "x" }));
    expect(r.of("caps")[0]!.models).toBeUndefined();
    r.send({ cmd: "model", id: "other" });
    expect(r.of("error").at(-1)!.msg).toBe("This engine has only one model.");
  });
});

describe("switching models in the middle of a conversation", () => {
  test("the next message goes to the new model, which sees everything said so far", async () => {
    const { first, second, caps } = pair();
    await first.turn(prompt("remember the word kiwi"));
    await first.turn({ cmd: "model", id: "small" });
    expect(caps().models!.find((m) => m.current)!.id).toBe("small");
    await first.turn(prompt("what was the word?"));
    expect(second.requests).toHaveLength(1);
    expect(JSON.stringify(second.requests[0]!.messages)).toContain("kiwi");
    expect(first.text()).toContain("from the small one");
    expect(first.provider.requests).toHaveLength(1);
    first.cleanup();
  });
  test("an unknown model and the one already in use change nothing", async () => {
    const { first, used, caps } = pair();
    await first.turn({ cmd: "model", id: "nope" });
    expect(first.of("error").at(-1)!.msg).toBe('There is no model "nope".');
    first.send({ cmd: "model", id: "big" });
    expect(used).toEqual(["nope"]);
    expect(caps().models!.find((m) => m.current)!.id).toBe("big");
    first.cleanup();
  });
  test("a model can be chosen while a reply is being written: it is shown at once, the reply finishes with the model it started with, and the next message goes to the new one", async () => {
    const { first, second, caps } = pair();
    first.send(prompt("slow"));
    first.send({ cmd: "model", id: "small" });
    expect(first.of("error")).toHaveLength(0);
    expect(caps().models!.find((m) => m.current)!.id).toBe("small");
    await first.engine.idle();
    expect(first.text()).toContain("from the big one");
    expect(first.provider.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
    await first.turn(prompt("and now"));
    expect(second.requests).toHaveLength(1);
    expect(caps().models!.find((m) => m.current)!.id).toBe("small");
    first.cleanup();
  });
  test("a conversation too long for the new model is summarised by the model that can still read it, not cut", async () => {
    const { first, second, caps } = pair({ smallWindow: 3_000 });
    for (let i = 0; i < 3; i++) await first.turn(prompt(`note ${i}: ${"word ".repeat(1200)}`));
    await first.turn({ cmd: "model", id: "small" });
    expect(first.provider.summaries.length).toBeGreaterThan(0);
    expect(second.summaries).toHaveLength(0);
    const usage = first.of("usage").at(-1)!;
    expect(usage.win).toBe(3_000);
    expect(usage.ctx).toBeLessThan(3_000 * 0.85);
    expect(caps().models!.find((m) => m.current)!.id).toBe("small");
    first.cleanup();
  });
  test("a prompt sent in the same instant as a model switch is not stranded in the queue: it runs as soon as the switch is applied", async () => {
    const { first, caps } = pair();
    first.send({ cmd: "model", id: "small" });
    first.send(prompt("halo", { qid: "q1" }));
    await first.engine.idle();
    expect(first.of("queued")).toHaveLength(1);
    expect(first.of("user")).toHaveLength(1);
    expect(first.of("taken")).toHaveLength(1);
    expect(first.text()).toContain("from the small one");
    expect(first.of("done").at(-1)).toMatchObject({ stop: "end_turn" });
    expect(caps().models!.find((m) => m.current)!.id).toBe("small");
    first.cleanup();
  });
  test("a prompt sent in the same instant as a manual compact is not stranded either", async () => {
    const { first } = pair();
    first.send(prompt("remember the word kiwi"));
    await first.engine.idle();
    first.send({ cmd: "compact" });
    first.send(prompt("what was the word?", { qid: "q1" }));
    await first.engine.idle();
    expect(first.of("queued")).toHaveLength(1);
    expect(first.of("taken").map((e) => e.qid)).toEqual(["q1"]);
    expect(first.of("done").at(-1)).toMatchObject({ stop: "end_turn" });
    first.cleanup();
  });
  test("a switch that fails leaves the engine free: it says so, and the next prompt runs instead of waiting for ever", async () => {
    let calls = 0;
    const switcher: ModelSwitch = { models: MODELS, current: "big", use: (id) => { if (++calls > 1) throw new Error("the model list could not be read"); return { provider: first.provider, window: 100_000 }; } };
    const first = rig(() => ({ text: "from the big one" }), { switcher });
    first.send({ cmd: "model", id: "small" });
    await first.engine.idle();
    expect(first.of("error").at(-1)!.msg).toBe("the model list could not be read");
    expect(first.of("done").at(-1)).toMatchObject({ stop: "error" });
    first.send(prompt("are you there?", { qid: "q1" }));
    await first.engine.idle();
    expect(first.of("taken").map((e) => e.qid)).toEqual(["q1"]);
    expect(first.of("done").at(-1)).toMatchObject({ stop: "end_turn" });
    first.cleanup();
  });
  test("a prompt sent while the end of a turn is applying a chosen model (summarising first) runs next, and is not dropped", async () => {
    const { first } = pair({ smallWindow: 400 });
    for (let i = 0; i < 3; i++) await first.turn(prompt(`note ${i}: ${"word ".repeat(1200)}`));
    const summarise = first.provider.complete.bind(first.provider);
    first.provider.complete = async (...args) => { first.send(prompt("late one", { qid: "late" })); return summarise(...args); };
    first.send(prompt("one more", { qid: "last" }));
    first.send({ cmd: "model", id: "small" });
    await first.engine.idle();
    expect(first.of("dropped")).toEqual([]);
    expect(first.of("taken").map((e) => e.qid)).toEqual(expect.arrayContaining(["last", "late"]));
    expect(first.of("done").at(-1)).toMatchObject({ stop: "end_turn" });
    first.cleanup();
  });
  test("when even the last messages are too long for the new model, nothing changes and it says so", async () => {
    const { first, second, caps } = pair({ smallWindow: 400 });
    for (let i = 0; i < 3; i++) await first.turn(prompt(`note ${i}: ${"word ".repeat(1200)}`));
    await first.turn({ cmd: "model", id: "small" });
    expect(first.of("error").at(-1)!.msg).toContain("longer than that model can read");
    expect(caps().models!.find((m) => m.current)!.id).toBe("big");
    expect(first.of("done").at(-1)!.stop).toBe("error");
    await first.turn(prompt("still here?"));
    expect(second.requests).toHaveLength(0);
    expect(first.text()).toContain("from the big one");
    first.cleanup();
  });
  test("the effort level the new model does not have is dropped, and it is announced without effort levels", async () => {
    const { first, caps } = pair();
    first.send({ cmd: "effort", level: "high" });
    expect(caps().effort).toBe("high");
    await first.turn({ cmd: "model", id: "small" });
    expect(caps().effort).toBeUndefined();
    expect(caps().efforts).toBeUndefined();
    first.cleanup();
  });
});

describe("effort", () => {
  test("is set from the next message, shown in what the engine can do, and sent with the request", async () => {
    const { first, caps } = pair();
    first.send({ cmd: "effort", level: "high" });
    expect(caps().effort).toBe("high");
    await first.turn(prompt("think hard"));
    expect(first.provider.requests[0]!.effort).toBe("high");
    first.send({ cmd: "effort", level: "auto" });
    expect(caps().effort).toBeUndefined();
    await first.turn(prompt("again"));
    expect(first.provider.requests[1]!.effort).toBeUndefined();
    first.cleanup();
  });
  test("a level the model does not have, or any level on a model with none, is refused in plain words", () => {
    const { first } = pair();
    first.send({ cmd: "effort", level: "max" });
    expect(first.of("error").at(-1)!.msg).toBe("This model does not have the effort level max.");
    const bare = rig(() => ({ text: "x" }));
    bare.send({ cmd: "effort", level: "high" });
    expect(bare.of("error").at(-1)!.msg).toBe("This model has no effort setting.");
    bare.send({ cmd: "effort", level: "auto" });
    expect(bare.of("error")).toHaveLength(1);
  });
});
