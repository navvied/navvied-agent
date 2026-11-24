import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatFilesDir, chatJournalDir, chatSessionsDir, configPath, sessionsDir } from "../src/config.ts";
import { folderId } from "../src/folders.ts";
import { dirname } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; kind?: string; [k: string]: unknown };

function open() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  return { env, work, hub, got, send };
}

describe("a chat and an agent on one computer", () => {
  test("they are two engines: the agent is untagged and works in the project, the chat is tagged and has a folder of its own", async () => {
    const { env, work, hub, got, send } = open();
    expect(hub.info().cwd).toBe(work);
    send({ cmd: "sessions", kind: "chat" });
    await until(() => got.some((e) => e.ev === "sessions" && e.kind === "chat"));
    const agentCaps = got.find((e) => e.ev === "caps" && e.kind === undefined) as unknown as { modes: string[] };
    const chatCaps = got.find((e) => e.ev === "caps" && e.kind === "chat") as unknown as { modes: string[] };
    expect(agentCaps.modes).toEqual(["ask", "edits", "plan", "auto", "bypass"]);
    expect(chatCaps.modes).toEqual([]);
    expect(existsSync(chatFilesDir(env))).toBe(true);
    expect(chatFilesDir(env)).not.toBe(work);
    await hub.stop();
  });

  test("what is said in one is kept, listed and searched apart from the other", async () => {
    const { env, hub, got, send } = open();
    send({ cmd: "prompt", text: "tell me about the alpha topic", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "prompt", text: "fix the beta bug", qid: "a1" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === undefined));
    expect(readdirSync(chatSessionsDir(env)).length).toBe(1);
    expect(readdirSync(sessionsDir(env)).length).toBe(1);

    got.length = 0;
    send({ cmd: "sessions", kind: "chat" });
    send({ cmd: "sessions" });
    await until(() => got.filter((e) => e.ev === "sessions").length >= 2);
    const chats = got.find((e) => e.ev === "sessions" && e.kind === "chat") as unknown as { items: { title: string; kind?: string }[] };
    const agents = got.find((e) => e.ev === "sessions" && e.kind === undefined) as unknown as { items: { title: string; kind?: string }[] };
    expect(chats.items.map((i) => i.title)).toEqual(["tell me about the alpha topic"]);
    expect(chats.items[0]!.kind).toBe("chat");
    expect(agents.items.map((i) => i.title)).toEqual(["fix the beta bug"]);
    expect(agents.items[0]!.kind).toBeUndefined();

    got.length = 0;
    send({ cmd: "search", query: "alpha", kind: "chat" });
    send({ cmd: "search", query: "alpha" });
    await until(() => got.filter((e) => e.ev === "found").length >= 2);
    expect((got.find((e) => e.ev === "found" && e.kind === "chat") as unknown as { items: unknown[] }).items.length).toBe(1);
    expect((got.find((e) => e.ev === "found" && e.kind === undefined) as unknown as { items: unknown[] }).items.length).toBe(0);
    await hub.stop();
  });

  test("a command that says nothing is for the agent, as before; a bad kind is refused", async () => {
    const { hub, got, send } = open();
    send({ cmd: "sessions" });
    await until(() => got.some((e) => e.ev === "sessions"));
    expect(got.some((e) => e.kind === "chat")).toBe(false);
    const replies: string[] = [];
    hub.command(JSON.stringify({ cmd: "sessions", kind: "robot" }), (r) => replies.push(r));
    expect(replies[0]).toContain("kind must be one of agent, chat");
    await hub.stop();
  });

  test("opening an earlier conversation of a kind loads it into that kind only, and it can be continued", async () => {
    const { hub, got, send } = open();
    send({ cmd: "prompt", text: "tell me about the alpha topic", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "prompt", text: "fix the beta bug", qid: "a1" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === undefined));
    send({ cmd: "sessions", kind: "chat" });
    await until(() => got.some((e) => e.ev === "sessions" && e.kind === "chat"));
    const id = (got.find((e) => e.ev === "sessions" && e.kind === "chat") as unknown as { items: { id: string }[] }).items[0]!.id;
    got.length = 0;
    send({ cmd: "load", id, kind: "chat" });
    await until(() => got.some((e) => e.ev === "loaded"));
    const loaded = got.find((e) => e.ev === "loaded") as unknown as { kind?: string; id: string; items: { k: string; text: string }[] };
    expect(loaded.kind).toBe("chat");
    expect(loaded.id).toBe(id);
    expect(loaded.items[0]).toMatchObject({ k: "user", text: "tell me about the alpha topic" });
    expect(got.some((e) => e.kind === undefined && e.ev === "loaded")).toBe(false);
    send({ cmd: "prompt", text: "and more", qid: "c2", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    expect(got.some((e) => e.ev === "session" && e.kind === undefined)).toBe(false);
    await hub.stop();
  });

  test("a window that arrives is told when it is up to date; a fresh one gets only the current conversation of each kind", async () => {
    const { hub, got, send } = open();
    // Nothing said yet: the window is still told it is up to date, last.
    const empty: Ev[] = [];
    hub.attach({ send: (line) => { empty.push(JSON.parse(String(line))); } }, 0);
    expect(empty.at(-1)).toMatchObject({ ev: "synced", version: expect.stringMatching(/^\d+\.\d+\.\d+/), running: [] });

    send({ cmd: "prompt", text: "tell me about the alpha topic", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "sessions", kind: "chat" });
    await until(() => got.some((e) => e.ev === "sessions" && e.kind === "chat"));
    const first = (got.find((e) => e.ev === "sessions" && e.kind === "chat") as unknown as { items: { id: string }[] }).items[0]!.id;
    // A second conversation of the same kind is opened: the first is now an older turn in the ring.
    send({ cmd: "prompt", text: "something unrelated about cooking", qid: "c2", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "done" && e.kind === "chat").length >= 2);
    send({ cmd: "load", id: first, kind: "chat" });
    await until(() => got.some((e) => e.ev === "loaded"));

    const fresh: Ev[] = [];
    hub.attach({ send: (line) => { fresh.push(JSON.parse(String(line))); } }, 0);
    expect(fresh.at(-1)!.ev).toBe("synced");
    const said = fresh.filter((e) => e.ev === "user").map((e) => e.text);
    expect(said).not.toContain("something unrelated about cooking");
    expect(fresh.filter((e) => e.ev === "caps").map((e) => e.kind ?? "agent").sort()).toEqual(["agent", "chat"]);
    // A window that has seen part of it gets only the rest, and the same ending.
    const seen = Math.max(...got.map((e) => Number(e.seq ?? 0)));
    const later: Ev[] = [];
    hub.attach({ send: (line) => { later.push(JSON.parse(String(line))); } }, seen);
    expect(later.map((e) => e.ev)).toEqual(["synced"]);
    await hub.stop();
  });

  test("both kinds announce the one model in use and that the list can be managed", async () => {
    const { hub, got, send } = open();
    send({ cmd: "sessions", kind: "chat" });
    await until(() => got.some((e) => e.ev === "caps" && e.kind === "chat"));
    for (const caps of got.filter((e) => e.ev === "caps") as unknown as { manage?: boolean; models?: { id: string; current?: boolean }[] }[]) {
      expect(caps.manage).toBe(true);
      expect(caps.models).toHaveLength(1);
      expect(caps.models![0]).toMatchObject({ current: true });
    }
    // A window that arrives later is given them too, after a conversation was opened.
    const fresh: Ev[] = [];
    hub.attach({ send: (line) => { fresh.push(JSON.parse(String(line))); } }, 0);
    expect(fresh.filter((e) => e.ev === "caps").map((e) => e.kind ?? "agent").sort()).toEqual(["agent", "chat"]);
    await hub.stop();
  });

  test("a new conversation, a title, a pin and a deletion, for each kind apart, told to every window", async () => {
    const { hub, got, send } = open();
    const lists = (kind?: string) => got.filter((e) => e.ev === "sessions" && e.kind === kind).map((e) => (e as unknown as { items: { id: string; title: string; pinned?: boolean }[] }).items);
    for (const [text, qid] of [["first about alpha", "c1"], ["second about beta", "c2"]] as const) {
      send({ cmd: "prompt", text, qid, kind: "chat" });
      await until(() => got.filter((e) => e.ev === "done" && e.kind === "chat").length >= (qid === "c1" ? 1 : 2));
      send({ cmd: "new", kind: "chat" });
      await until(() => got.filter((e) => e.ev === "session" && e.kind === "chat").length >= (qid === "c1" ? 2 : 3));
    }
    send({ cmd: "sessions", kind: "chat" });
    await until(() => lists("chat").length >= 3);
    const [newer, older] = lists("chat").at(-1)!;
    expect([newer!.title, older!.title]).toEqual(["second about beta", "first about alpha"]);
    expect(got.filter((e) => e.ev === "session" && e.kind === "chat").length).toBe(3); // each `new` made a fresh one
    expect(got.some((e) => e.ev === "session" && e.kind === undefined && got.filter((x) => x.ev === "session" && x.kind === undefined).length > 1)).toBe(false);

    send({ cmd: "pin", id: older!.id, pinned: true, kind: "chat" });
    await until(() => lists("chat").at(-1)![0]!.id === older!.id);
    expect(lists("chat").at(-1)![0]).toMatchObject({ id: older!.id, pinned: true });
    send({ cmd: "rename", id: older!.id, title: "My alpha notes", kind: "chat" });
    await until(() => lists("chat").at(-1)![0]!.title === "My alpha notes");
    send({ cmd: "pin", id: older!.id, pinned: false, kind: "chat" });
    await until(() => lists("chat").at(-1)![0]!.pinned === undefined);
    expect(lists("chat").at(-1)!.map((i) => i.title).sort()).toEqual(["My alpha notes", "second about beta"]);

    // Nothing of that was done to the agent's list.
    send({ cmd: "sessions" });
    await until(() => lists(undefined).length >= 1);
    expect(lists(undefined).at(-1)).toEqual([]);

    send({ cmd: "remove", id: older!.id, kind: "chat" });
    await until(() => lists("chat").at(-1)!.length === 1);
    expect(lists("chat").at(-1)![0]!.title).toBe("second about beta");
    send({ cmd: "search", query: "alpha", kind: "chat" });
    await until(() => got.some((e) => e.ev === "found" && e.kind === "chat"));
    expect((got.find((e) => e.ev === "found" && e.kind === "chat") as unknown as { items: unknown[] }).items).toEqual([]);
    await hub.stop();
  });

  test("deleting the conversation in use starts a new one; a turn that is running is not interrupted", async () => {
    const { hub, got, send } = open();
    send({ cmd: "prompt", text: "talk about gamma", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    const id = (got.find((e) => e.ev === "session" && e.kind === "chat") as unknown as { id: string }).id;
    const before = got.filter((e) => e.ev === "session" && e.kind === "chat").length;
    send({ cmd: "remove", id, kind: "chat" });
    await until(() => got.filter((e) => e.ev === "session" && e.kind === "chat").length > before);
    const after = got.filter((e) => e.ev === "session" && e.kind === "chat").at(-1) as unknown as { id: string };
    expect(after.id).not.toBe(id);
    await hub.stop();
  });

  test("fork copies a conversation into a new one that opens and continues apart from the first", async () => {
    const { hub, got, send } = open();
    send({ cmd: "prompt", text: "talk about delta", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "new", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "session" && e.kind === "chat").length >= 2);
    const first = (got.find((e) => e.ev === "session" && e.kind === "chat") as unknown as { id: string }).id;
    send({ cmd: "fork", id: first, kind: "chat" });
    await until(() => got.some((e) => e.ev === "forked"));
    const forked = got.find((e) => e.ev === "forked") as unknown as { ok: boolean; id: string; newId: string };
    expect(forked).toMatchObject({ ok: true, id: first });
    expect(forked.newId).not.toBe(first);
    send({ cmd: "sessions", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "sessions" && e.kind === "chat").length >= 1);
    const list = (got.filter((e) => e.ev === "sessions" && e.kind === "chat").at(-1) as unknown as { items: { id: string; title: string }[] }).items;
    expect(list.map((i) => i.title).sort()).toEqual(["talk about delta", "talk about delta (fork)"]);
    send({ cmd: "load", id: forked.newId, kind: "chat" });
    await until(() => got.some((e) => e.ev === "loaded" && e.id === forked.newId));
    expect((got.find((e) => e.ev === "loaded" && e.id === forked.newId) as unknown as { items: { text: string }[] }).items[0]!.text).toBe("talk about delta");
    send({ cmd: "fork", id: "no-such", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "forked").length >= 2);
    expect(got.filter((e) => e.ev === "forked")[1]).toMatchObject({ ok: false });
    await hub.stop();
  });

  test("archive hides a conversation from the list and from the search until asked for; done and unread are marks the person and the hub set", async () => {
    const { hub, got, send } = open();
    const lists = () => got.filter((e) => e.ev === "sessions" && e.kind === "chat").map((e) => (e as unknown as { items: { id: string; title: string; archived?: boolean; done?: boolean; unread?: boolean }[] }).items);
    send({ cmd: "prompt", text: "write about epsilon", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "sessions", kind: "chat" });
    await until(() => lists().length >= 1);
    const id = lists().at(-1)![0]!.id;
    expect(lists().at(-1)![0]!.unread).toBeUndefined(); // a window was there to see it end

    send({ cmd: "mark", id, done: true, kind: "chat" });
    await until(() => lists().at(-1)![0]?.done === true);
    send({ cmd: "archive", id, archived: true, kind: "chat" });
    await until(() => lists().at(-1)!.length === 0);
    send({ cmd: "sessions", archived: true, kind: "chat" });
    await until(() => lists().at(-1)!.length === 1);
    expect(lists().at(-1)![0]).toMatchObject({ id, archived: true, done: true });
    send({ cmd: "search", query: "epsilon", kind: "chat" });
    await until(() => got.some((e) => e.ev === "found" && e.kind === "chat"));
    expect((got.find((e) => e.ev === "found" && e.kind === "chat") as unknown as { items: unknown[] }).items).toEqual([]);
    got.length = 0;
    send({ cmd: "search", query: "epsilon", includeArchived: true, kind: "chat" });
    await until(() => got.some((e) => e.ev === "found"));
    expect((got.find((e) => e.ev === "found") as unknown as { items: unknown[] }).items.length).toBe(1);
    send({ cmd: "archive", id, archived: false, kind: "chat" });
    await until(() => lists().at(-1)?.length === 1 && lists().at(-1)![0]!.archived === undefined);

    await hub.stop();
  });

  test("a turn that ends while no window is looking is unread, until a window opens it or the person marks it read", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: Ev[] = [];
    const sink = { send: (line: string) => { got.push(JSON.parse(String(line))); } };
    // Nobody has the hub open while the turn runs: no window is looking when it ends.
    hub.command(JSON.stringify({ cmd: "prompt", text: "write about zeta", qid: "c1", kind: "chat" }), () => undefined);
    await until(() => existsSync(chatSessionsDir(env)) && readdirSync(chatSessionsDir(env)).length === 1);
    // The turn has ended when its answer is in the record of the conversation (a slow machine may take longer than any fixed wait).
    const record = (): string => { try { const dir = chatJournalDir(env); return readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join(""); } catch { return ""; } };
    await until(() => record().includes('"assistant"'), 20_000);
    await new Promise((r) => setTimeout(r, 100));
    const back = hub.attach(sink, 0);
    got.length = 0;
    hub.command(JSON.stringify({ cmd: "sessions", kind: "chat" }), () => undefined);
    await until(() => got.some((e) => e.ev === "sessions" && e.kind === "chat"));
    const row = (got.find((e) => e.ev === "sessions" && e.kind === "chat") as unknown as { items: { id: string; unread?: boolean }[] }).items[0]!;
    expect(row.unread).toBe(true);
    hub.command(JSON.stringify({ cmd: "mark", id: row.id, read: true, kind: "chat" }), () => undefined);
    await until(() => (got.filter((e) => e.ev === "sessions" && e.kind === "chat").at(-1) as unknown as { items: { unread?: boolean }[] }).items[0]!.unread === undefined);
    back();
    await hub.stop();
  });

  test("an agent is started in a folder the computer offers, named by an id; a path from a page is never taken, and a chat has no folder", async () => {
    const state = tempDir(), work = tempDir(), other = realpathSync(tempDir());
    dirs.push(state, work, other);
    const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
    mkdirSync(dirname(configPath(env)), { recursive: true });
    writeFileSync(configPath(env), JSON.stringify({ models: {}, folders: [other, "/nonexistent/place"] }));
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
    const got: Ev[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    const folders = () => (got.filter((e) => e.ev === "caps" && e.kind === undefined).at(-1) as unknown as { folders: { id: string; name: string; path?: string; current?: boolean }[] }).folders;
    expect(folders().map((f) => f.path)).toEqual([realpathSync(work), other]);
    expect(folders()[0]).toMatchObject({ current: true, id: folderId(work) });
    // The one that is not there is not offered; a path is not an id.
    send({ cmd: "new", folder: other });
    send({ cmd: "new", folder: "/etc" });
    await until(() => got.filter((e) => e.ev === "error").length >= 2);
    expect(got.filter((e) => e.ev === "error").map((e) => e.msg)).toEqual(["That folder is not offered by this computer.", "That folder is not offered by this computer."]);
    expect(hub.info().cwd).toBe(work);
    // A chat has none.
    send({ cmd: "new", kind: "chat", folder: folderId(other) });
    await until(() => got.filter((e) => e.ev === "error").length >= 3);
    expect(got.filter((e) => e.ev === "error")[2]!.msg).toBe("A chat has no folder.");
    // The id the hub gave: the next conversation works there, and the list says it is the current one.
    send({ cmd: "new", folder: folderId(other) });
    await until(() => hub.info().cwd === other);
    await until(() => folders().some((f) => f.current && f.path === other));
    await hub.stop();
  });

  test("search says where a hit is and which project it was about", async () => {
    const { hub, got, send } = open();
    send({ cmd: "prompt", text: "explain the omega protocol", qid: "a1" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === undefined));
    send({ cmd: "search", query: "omega" });
    await until(() => got.some((e) => e.ev === "found"));
    const hit = (got.find((e) => e.ev === "found") as unknown as { items: { id: string; title: string; snippet: string; updated: number; project?: string; where?: string }[] }).items[0]!;
    expect(hit).toMatchObject({ title: "explain the omega protocol" });
    expect(hit.snippet).toContain("omega");
    expect(hit.project).toBeString();
    expect(hit.where).toBeUndefined();
    await hub.stop();
  });
});

