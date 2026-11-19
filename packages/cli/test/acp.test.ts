import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/main.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Msg = { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string }; params?: Record<string, any> };

/** An editor on the other end of the pipes. */
function editor(args: string[] = []) {
  const dir = tempDir(); dirs.push(dir);
  const env = { HOME: dir, XDG_STATE_HOME: dir, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const f = fakeIO({ env });
  const done = main(["acp", "--cwd", dir, ...args], f.io);
  const read = (): Msg[] => f.out().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Msg);
  const send = (m: object): void => { f.input.push(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`); };
  const reply = async (id: number): Promise<Msg> => { await until(() => read().some((m) => m.id === id && (m.result !== undefined || m.error !== undefined) && m.method === undefined)); return read().find((m) => m.id === id && m.method === undefined)!; };
  return { dir, send, read, reply, close: async () => { f.input.end(); await done; } };
}

describe("navvied acp, for an editor", () => {
  test("it introduces itself, opens a session, and streams the answer as updates before saying it is done", async () => {
    const e = editor();
    e.send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    const init = await e.reply(1);
    expect(init.result).toMatchObject({ protocolVersion: 1, agentInfo: { name: "navvied" }, agentCapabilities: { loadSession: false } });
    e.send({ id: 2, method: "session/new", params: { cwd: e.dir, mcpServers: [] } });
    const sessionId = (await e.reply(2)).result!.sessionId as string;
    e.send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hello there" }] } });
    const done = await e.reply(3);
    expect(done.result).toEqual({ stopReason: "end_turn" });
    const chunks = e.read().filter((m) => m.method === "session/update" && m.params?.update.sessionUpdate === "agent_message_chunk").map((m) => m.params!.update.content.text).join("");
    expect(chunks).toContain("all done here");
    expect(e.read().findIndex((m) => m.id === 3)).toBeGreaterThan(e.read().findIndex((m) => m.method === "session/update"));
    await e.close();
  });
  test("a change to a file is asked of the editor, and the editor's answer decides: allowed, it happens; refused, it does not", async () => {
    for (const choice of ["allow", "deny"]) {
      const e = editor();
      e.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
      e.send({ id: 2, method: "session/new", params: { cwd: e.dir } });
      const sessionId = (await e.reply(2)).result!.sessionId as string;
      const target = join(e.dir, `${choice}.txt`);
      e.send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: `write ${target}` }] } });
      await until(() => e.read().some((m) => m.method === "session/request_permission"));
      const asked = e.read().find((m) => m.method === "session/request_permission")!;
      expect(asked.params!.options.map((o: { optionId: string }) => o.optionId)).toContain("allow");
      expect(asked.params!.toolCall.title).toContain("Write");
      e.send({ id: asked.id, result: { outcome: { outcome: "selected", optionId: choice } } });
      expect((await e.reply(3)).result).toEqual({ stopReason: "end_turn" });
      expect(existsSync(target)).toBe(choice === "allow");
      const updates = e.read().filter((m) => m.method === "session/update").map((m) => m.params!.update);
      expect(updates.some((u) => u.sessionUpdate === "tool_call" && u.kind === "edit")).toBe(true);
      expect(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === (choice === "allow" ? "completed" : "failed"))).toBe(true);
      await e.close();
    }
  });
  test("a cancel stops the work and the answer says so", async () => {
    const e = editor();
    e.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    e.send({ id: 2, method: "session/new", params: { cwd: e.dir } });
    const sessionId = (await e.reply(2)).result!.sessionId as string;
    e.send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "be slow please slow" }] } });
    await new Promise((r) => setTimeout(r, 300));
    e.send({ method: "session/cancel", params: { sessionId } });
    expect((await e.reply(3)).result).toEqual({ stopReason: "cancelled" });
    await e.close();
  });
  test("what it cannot do is answered with an error, not silence", async () => {
    const e = editor();
    e.send({ id: 1, method: "session/prompt", params: { sessionId: "nope", prompt: [{ type: "text", text: "x" }] } });
    expect((await e.reply(1)).error?.message).toBe("unknown session");
    e.send({ id: 2, method: "something/else", params: {} });
    expect((await e.reply(2)).error?.code).toBe(-32601);
    e.send({ id: 3, method: "session/new", params: { cwd: e.dir } });
    const sessionId = (await e.reply(3)).result!.sessionId as string;
    e.send({ id: 4, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect((await e.reply(4)).error?.message).toContain("no text");
    await e.close();
  });
});
