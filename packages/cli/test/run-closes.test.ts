import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/main.ts";
import { Conversations } from "../src/conversations.ts";
import { searchIndexPath } from "../src/config.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

function setup() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  return { state, work, env: { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" } };
}

const stillOpen = (folder: string): string[] => readdirSync("/proc/self/fd").flatMap((fd) => {
  try {
    const at = readlinkSync(`/proc/self/fd/${fd}`);
    return at.startsWith(`${folder}/`) ? [at.slice(folder.length + 1)] : [];
  } catch { return []; }
});

describe("a command that has ended holds no file of its own", () => {
  test("run saves its conversation, then lets the search database go, so its folder can be removed on every system", async () => {
    const s = setup();
    expect(await main(["run", "say hello", "--cwd", s.work], fakeIO({ env: s.env }).io)).toBe(0);
    expect(existsSync(searchIndexPath(s.env))).toBe(true);
    if (process.platform === "linux") expect(stillOpen(s.state)).toEqual([]);
  });

  test("the same for a program that drives it as an editor does", async () => {
    const s = setup();
    const f = fakeIO({ env: s.env });
    const done = main(["acp", "--cwd", s.work], f.io);
    const say = (m: object): void => { f.input.push(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`); };
    const replies = (): { id?: number; method?: string; result?: Record<string, unknown> }[] => f.out().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const reply = async (id: number): Promise<Record<string, unknown>> => { await until(() => replies().some((m) => m.id === id && !m.method && m.result !== undefined)); return replies().find((m) => m.id === id && !m.method)!.result!; };
    say({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    say({ id: 2, method: "session/new", params: { cwd: s.work, mcpServers: [] } });
    const { sessionId } = await reply(2);
    say({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello there" }] } });
    await reply(3);
    expect(existsSync(searchIndexPath(s.env))).toBe(true);
    f.input.end();
    expect(await done).toBe(0);
    if (process.platform === "linux") expect(stillOpen(s.state)).toEqual([]);
  });

  test("a book that was closed opens nothing again, whatever is still being said", () => {
    const s = setup();
    const book = new Conversations("agent", s.env);
    expect(book.index).toBeDefined();
    book.close();
    expect(book.index).toBeUndefined();
    if (process.platform === "linux") expect(stillOpen(s.state)).toEqual([]);
  });
});
