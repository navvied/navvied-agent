import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHub, type Client, type Hub } from "../src/commands/hub.ts";
import { startAskingModel } from "./asking-model.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const hubs: Hub[] = [];
let model: ReturnType<typeof startAskingModel>;
beforeAll(() => { model = startAskingModel(); });
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.stop(); model.heard.length = 0; });
afterAll(() => { model.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
function start(more: Record<string, string> = {}): Hub {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: model.url, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000", ...more };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  hubs.push(hub);
  return hub;
}
function open(hub: Hub, client: Omit<Client, "send"> = {}, since = 0) {
  const got: Ev[] = [];
  const window = hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); }, ...client }, since);
  const send = (cmd: object): void => window.command(JSON.stringify(cmd));
  const of = (ev: string): Ev[] => got.filter((e) => e.ev === ev);
  return { got, of, send, window };
}
const prompt = (extra: object = {}) => ({ cmd: "prompt", text: "set it up", qid: crypto.randomUUID(), ...extra });
const NOBODY = "Nobody can answer now";

/** The turn this window started asks, `answerer` answers, and the model has that answer. */
async function asksAndHears(sender: ReturnType<typeof open>, answerer = sender, send: () => void = () => sender.send(prompt())): Promise<void> {
  const before = answerer.of("question").length, heard = model.heard.length;
  send();
  await until(() => answerer.of("question").length > before || model.heard.length > heard);
  expect(model.heard.slice(heard)).toEqual([]);
  const q = answerer.of("question").at(-1) as unknown as { id: string; questions: unknown[] };
  expect(q.questions).toEqual([{ question: "Which port?", choices: ["80", "8080"] }]);
  answerer.send({ cmd: "answer", id: q.id, answers: [["80"]] });
  await until(() => model.heard.length > heard);
  expect(model.heard[heard]).toBe('Which port? -> "80"');
  await until(() => sender.of("done").length > 0);
}

async function toldNobody(sender: ReturnType<typeof open>, send: () => void = () => sender.send(prompt())): Promise<void> {
  const heard = model.heard.length, done = sender.of("done").length;
  send();
  await until(() => sender.of("done").length > done);
  expect(model.heard[heard]).toContain(NOBODY);
}

describe("who the agent's questions are put to", () => {
  test("a window built into the program says at attach that it draws them", async () => {
    const w = open(start(), { questions: true });
    await asksAndHears(w);
    expect(w.got.find((e) => e.ev === "caps")).toMatchObject({ questions: true });
  });

  test("a window that says nothing is not counted: the agent is told nobody can answer, and goes on", async () => {
    const w = open(start());
    await toldNobody(w);
    expect(w.of("question")).toEqual([]);
  });

  test("a window on a wire is told the hub takes its word, and is asked once it has given it", async () => {
    const w = open(start());
    expect(w.of("synced")[0]).toMatchObject({ windows: true });
    w.send({ cmd: "window", questions: true });
    await asksAndHears(w);
    w.send({ cmd: "window", questions: false });
    await toldNobody(w);
  });

  test("a prompt that carries the word is enough, even when nothing came before it", async () => {
    const w = open(start());
    await asksAndHears(w, w, () => w.send(prompt({ questions: true })));
  });

  test("the program that runs the hub is not a window: its word counts for nobody", async () => {
    const hub = start();
    const w = open(hub);
    await toldNobody(w, () => { hub.command(JSON.stringify({ cmd: "window", questions: true }), () => undefined); hub.command(JSON.stringify(prompt({ questions: true })), () => undefined); });
    expect(w.of("error")).toEqual([]);
  });

  test("a silent window's turn is answered by a window beside it, and by nobody once that one has gone", async () => {
    const hub = start();
    const silent = open(hub), page = open(hub);
    page.send({ cmd: "window", questions: true });
    await asksAndHears(silent, page);
    page.window.detach();
    await toldNobody(silent);
  });

  test("what a window sends after it left does not count it again", async () => {
    const hub = start();
    const gone = open(hub), silent = open(hub);
    gone.window.detach();
    gone.send({ cmd: "window", questions: true });
    await toldNobody(silent);
  });

  test("when the last answering window leaves, a waiting question stays for the next window, which answers it", async () => {
    const hub = start();
    const first = open(hub), watcher = open(hub);
    first.send(prompt({ questions: true }));
    await until(() => first.of("question").length === 1);
    first.window.detach();
    await Bun.sleep(100);
    expect(model.heard).toEqual([]);
    const next = open(hub);
    const q = next.of("question")[0] as unknown as { id: string };
    expect(q).toBeDefined();
    next.send({ cmd: "window", questions: true });
    next.send({ cmd: "answer", id: q.id, answers: [["8080"]] });
    await until(() => watcher.of("done").length === 1);
    expect(model.heard).toEqual(['Which port? -> "8080"']);
  });

  test("and when no window comes back, the wait ends by itself and the turn goes on", async () => {
    const hub = start({ NAVVIED_ASK_WAIT_SECONDS: "1" });
    const first = open(hub), watcher = open(hub);
    first.send(prompt({ questions: true }));
    await until(() => first.of("question").length === 1);
    first.window.detach();
    await until(() => watcher.of("done").length === 1, 10_000);
    expect(model.heard[0]).toStartWith("No answer came in time.");
  });
});
