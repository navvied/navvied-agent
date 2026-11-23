import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { handedOver } from "../src/handover.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
/** Every hub made here is stopped before its folders are removed: a hub that is still running holds its engines, their programs and their folders (Windows will not remove a folder that something still has open). */
const hubs: { stop(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(hubs.map((h) => h.stop())); mock.stop(); dirs.forEach(remove); });

const AGENT = join(import.meta.dir, "../../stream-engine/test/fake-agent.ts");
type Ev = { ev: string; msg?: string; text?: string; id?: string; models?: { id: string; name: string; current?: boolean; handover?: boolean }[]; items?: { k: string; text: string }[]; [k: string]: unknown };

/** One computer with a model navvied runs itself and a program; `default` says which the conversation starts with. */
function open(first: "own" | "prog", extra: Record<string, unknown> = {}, kind?: "chat") {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const argvLog = join(state, "argv.log");
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    default: first,
    models: {
      own: { baseUrl: mock.url, model: "mock-model", window: 100000, apiKey: "k", display: { name: "The own one" } },
      other: { baseUrl: mock.url, model: "mock-model", window: 100000, apiKey: "k" },
      prog: { command: "bun", args: [AGENT], window: 100000, env: { FAKE_ARGV_LOG: argvLog }, display: { name: "The program" } },
      ...extra,
    },
  }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(kind ? { kind } : {}) } as never, fakeIO({ env }).io, { watch: false, import: false });
  hubs.push(hub);
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const said = (ev: string): Ev[] => got.filter((e) => e.ev === ev);
  const turn = async (text: string): Promise<void> => { const n = said("done").length; send({ cmd: "prompt", text, mode: "auto", qid: `q${n + 1}` }); await until(() => said("done").length > n); };
  const argv = (): string[] => { try { return readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
  return { hub, got, send, said, turn, argv, file };
}
const lastCaps = (r: ReturnType<typeof open>) => r.said("caps").at(-1)!;

describe("every model is in one list, whichever kind of engine the conversation has now", () => {
  test("an engine of navvied's lists the program beside its own models, and a program lists navvied's models beside its own", async () => {
    const a = open("own");
    await until(() => a.said("caps").length > 0);
    expect(lastCaps(a).models!.map((m) => m.id).sort()).toEqual(["other", "own", "prog"]);
    expect(lastCaps(a).models!.find((m) => m.id === "own")!.current).toBe(true);
    expect(lastCaps(a).models!.find((m) => m.id === "prog")!.handover).toBe(true);
    expect(lastCaps(a).models!.find((m) => m.id === "own")!.handover).toBeUndefined();
    expect(lastCaps(a).models!.find((m) => m.id === "other")!.handover).toBeUndefined();
    const b = open("prog");
    await until(() => b.said("caps").length > 0);
    expect(lastCaps(b).models!.map((m) => m.id)).toEqual(expect.arrayContaining(["own", "other"]));
    expect(lastCaps(b).models!.find((m) => m.id === "own")!.current).toBeFalsy();
  });
});

describe("a conversation goes on with a model that another engine runs, with what was said so far", () => {
  test("from navvied's engine to a program: the program is told the earlier turns with its instructions, and the person is told it was handed over", async () => {
    const r = open("own");
    await r.turn("remember the word kiwi");
    expect(r.hub.created()!.program).toBeUndefined();
    r.send({ cmd: "model", id: "prog" });
    await until(() => r.said("notice").some((e) => e.msg === handedOver("The program")));
    expect(r.hub.created()!.program).toBe(true);
    await r.turn("what was the word?");
    const started = r.argv().at(-1)!;
    expect(started).toContain("--append-system-prompt");
    expect(started).toContain("remember the word kiwi");
    // The earlier turns are written down under the id the program gave the conversation, and the new ones follow them.
    const id = r.said("session").at(-1)!.id!;
    r.send({ cmd: "load", id });
    await until(() => r.said("loaded").some((e) => e.id === id));
    const items = r.said("loaded").find((e) => e.id === id)!.items!;
    expect(items.map((i) => i.text).slice(0, 1)).toEqual(["remember the word kiwi"]);
    expect(items.some((i) => i.text === "what was the word?")).toBe(true);
  });

  test("from a program to navvied's engine: the engine really holds the earlier turns, so the model is sent them with the next message", async () => {
    const r = open("prog");
    await r.turn("hello from the program");
    const id = r.hub.created()!.engine.sessionId;
    r.send({ cmd: "model", id: "own" });
    await until(() => r.said("notice").some((e) => e.msg === handedOver("The own one")));
    expect(r.hub.created()!.program).toBeUndefined();
    expect(r.hub.created()!.engine.sessionId).toBe(id);
    mock.requests.length = 0;
    await r.turn("and now?");
    const sent = JSON.stringify(mock.requests.at(-1)!.body.messages);
    expect(sent).toContain("hello from the program");
    expect(sent).toContain("and now?");
  });

  test("the first thing the new engine says names the new model as the one in use, in either direction", async () => {
    for (const [from, to] of [["own", "prog"], ["prog", "own"]] as const) {
      const r = open(from);
      await r.turn("first");
      const before = r.said("caps").length;
      r.send({ cmd: "model", id: to });
      await until(() => r.said("notice").length > 0);
      const first = r.said("caps")[before]!;
      expect(first.models!.filter((m) => m.current).map((m) => m.id)).toEqual([to]);
    }
  });

  test("a reply that is being written finishes first: the hand-over waits for its end, and nothing is closed before", async () => {
    const r = open("own");
    r.send({ cmd: "prompt", text: "be held please", mode: "auto", qid: "q1" });
    await until(() => mock.streaming() > 0);
    const engine = r.hub.created()!.engine;
    r.send({ cmd: "model", id: "prog" });
    // The command is taken up at once, so what is closed would be closed by now.
    expect(r.hub.created()!.engine).toBe(engine);
    expect(r.said("notice")).toEqual([]);
    mock.release();
    await until(() => r.said("notice").some((e) => e.msg === handedOver("The program")));
    expect(r.said("done")).toHaveLength(1);
    expect(r.hub.created()!.program).toBe(true);
    expect(r.hub.created()!.engine).not.toBe(engine);
  });
});

describe("a switch that cannot be made is refused before the engine that works is closed", () => {
  test("a model that is not available yet, one that does not exist, and a program in a chat each say why, and the same engine answers on", async () => {
    const r = open("own", { later: { baseUrl: mock.url, model: "mock-model", window: 8000, display: { name: "Later one", locked: true } }, lockedProg: { command: "bun", args: [AGENT], display: { name: "Later program", locked: true } } });
    await r.turn("first");
    const engine = r.hub.created()!.engine;
    for (const [id, text] of [["lockedProg", "Later program is not available yet."], ["nothing", 'There is no model "nothing".']] as const) {
      r.send({ cmd: "model", id });
      await until(() => r.said("error").some((e) => e.msg === text));
      expect(r.hub.created()!.engine).toBe(engine);
    }
    expect(r.said("notice")).toEqual([]);
    await r.turn("still here?");
    expect(r.said("done")).toHaveLength(2);
    expect(r.said("error").filter((e) => /is not available yet|There is no model/.test(e.msg ?? ""))).toHaveLength(2);
  });

  test("a chat has no program to hand over to", async () => {
    const r = open("own", {}, "chat");
    await r.turn("first");
    const engine = r.hub.created()!.engine;
    r.send({ cmd: "model", id: "prog", kind: "chat" });
    await until(() => r.said("error").some((e) => /needs a model that navvied runs itself/.test(e.msg ?? "")));
    expect(r.hub.created()!.engine).toBe(engine);
    expect(lastCaps(r).models!.map((m) => m.id)).not.toContain("prog");
  });
});

describe("a model added while the conversation is still empty", () => {
  test("the conversation has nothing saved yet, so nothing is loaded: the switch says the line and no error", async () => {
    const r = open("own");
    await until(() => r.said("caps").length > 0);
    const config = JSON.parse(readFileSync(r.file, "utf8"));
    config.models.late = { baseUrl: mock.url, model: "mock-model", window: 100000, apiKey: "k", display: { name: "The late one" } };
    writeFileSync(r.file, JSON.stringify(config));
    r.send({ cmd: "model", id: "late" });
    await until(() => r.said("notice").some((e) => e.msg === handedOver("The late one")));
    expect(r.said("error")).toEqual([]);
    await r.turn("hello");
    expect(r.said("error")).toEqual([]);
  });

  test("after a first message the same switch still carries the conversation", async () => {
    const r = open("own");
    await r.turn("first");
    const config = JSON.parse(readFileSync(r.file, "utf8"));
    config.models.late = { baseUrl: mock.url, model: "mock-model", window: 100000, apiKey: "k", display: { name: "The late one" } };
    writeFileSync(r.file, JSON.stringify(config));
    r.send({ cmd: "model", id: "late" });
    await until(() => r.said("notice").some((e) => e.msg === handedOver("The late one")));
    await until(() => r.said("loaded").length === 1);
    expect(r.said("error")).toEqual([]);
  });
});

