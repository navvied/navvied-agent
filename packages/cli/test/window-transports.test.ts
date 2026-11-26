// What carries a window says nothing for it: over the program's own socket and over standard input, the agent asks exactly the windows
// that said they draw questions. (The relay is covered beside its other tests, in relay-host.test.ts.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHttpServer } from "../src/commands/serve-http.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { startAskingModel } from "./asking-model.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
let model: ReturnType<typeof startAskingModel>;
beforeAll(() => { model = startAskingModel(); });
afterAll(() => { model.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };
const TOKEN = "window-transports-token-01";
function setup() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: model.url, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000", NAVVIED_SERVE_TOKEN: TOKEN };
  return { options: { json: false, yes: false, thinking: false, cwd: work, port: 0 } as never, io: fakeIO({ env }) };
}

describe("`serve --http` (a page, and the desktop app)", () => {
  test("the socket that said it draws questions is asked; the app's own listening socket never counts", async () => {
    const { options, io } = setup();
    const started = await startHttpServer(options, io.io);
    if (!started.ok) throw new Error(started.error);
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${started.server.port}/ws`, [`navvied-key.${TOKEN}`]);
      const got: Ev[] = [];
      ws.onmessage = (m) => { got.push(JSON.parse(String(m.data))); };
      await new Promise<void>((r, no) => { ws.onopen = () => r(); ws.onerror = () => no(new Error("no socket")); });
      await until(() => got.some((e) => e.ev === "synced"));
      return { ws, got, of: (ev: string) => got.filter((e) => e.ev === ev), send: (cmd: object) => ws.send(JSON.stringify(cmd)) };
    };
    try {
      // what the desktop app's native side does: it listens with the app's key, for notices, and sends nothing of itself
      const listener = await connect();
      const page = await connect();
      expect(page.of("synced")[0]).toMatchObject({ windows: true });
      page.send({ cmd: "window", questions: true });
      const heard = model.heard.length;
      page.send({ cmd: "prompt", text: "set it up", qid: "h1" });
      await until(() => page.of("question").length === 1 || model.heard.length > heard);
      expect(model.heard.length).toBe(heard);
      page.send({ cmd: "answer", id: page.of("question")[0]!.id, answers: [["8080"]] });
      await until(() => page.of("done").length === 1);
      expect(model.heard[heard]).toBe('Which port? -> "8080"');

      page.ws.close();
      // the server has seen it go once a new socket has been served after it
      const after = await connect();
      await until(() => page.ws.readyState === WebSocket.CLOSED);
      await Bun.sleep(100);
      const dones = after.of("done").length;
      after.send({ cmd: "prompt", text: "again", qid: "h2" });
      await until(() => after.of("done").length > dones);
      expect(model.heard.at(-1)).toContain("Nobody can answer now");
      expect(listener.of("question").length).toBe(1);
      listener.ws.close();
      after.ws.close();
    } finally { await started.server.stop(); }
  });
});

describe("`serve --stdio` (a cloud session, an editor, a scheduled run)", () => {
  async function driven(line: object[]) {
    const { options, io } = setup();
    const done = serveCommand(options, io.io);
    const events = (): Ev[] => io.out().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
    for (const cmd of line) io.input.push(`${JSON.stringify(cmd)}\n`);
    return { events, push: (cmd: object) => io.input.push(`${JSON.stringify(cmd)}\n`), end: async () => { io.input.end(); await done; } };
  }

  test("a driver that only sends the work, as a scheduled run does, is told at once that nobody can answer", async () => {
    const heard = model.heard.length;
    const s = await driven([{ cmd: "prompt", text: "set it up", qid: "s1", mode: "auto" }]);
    await until(() => s.events().some((e) => e.ev === "done"));
    expect(s.events().some((e) => e.ev === "question")).toBe(false);
    expect(model.heard[heard]).toContain("Nobody can answer now");
    await s.end();
  });

  test("a page's message passed through it, as a cloud session does, is asked and answered", async () => {
    const heard = model.heard.length;
    const s = await driven([{ cmd: "prompt", text: "set it up", qid: "s1", questions: true }]);
    await until(() => s.events().some((e) => e.ev === "question") || model.heard.length > heard);
    expect(model.heard.length).toBe(heard);
    s.push({ cmd: "answer", id: s.events().find((e) => e.ev === "question")!.id, answers: [["80"]] });
    await until(() => s.events().some((e) => e.ev === "done"));
    expect(model.heard[heard]).toBe('Which port? -> "80"');
    await s.end();
  });
});
