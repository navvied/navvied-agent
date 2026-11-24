import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCommand, parseEvent, type Command, type Stamped } from "@navvied/protocol";
import { main } from "../src/main.ts";
import { fakeIO, fakeSystem, remove, startMockModel, tempDir, until, wait } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

function setup() {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  return { work, env: { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" } };
}
const events = (out: string): Stamped[] => out.trim().split("\n").filter(Boolean).map((l) => { const r = parseEvent(l); if (!r.ok) throw new Error(`not an event: ${l}`); return r.value; });

describe("serve --stdio", () => {
  test("speaks the protocol: caps first, then a full turn, then exits cleanly when stdin closes", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio", "--cwd", work], f.io);
    f.input.push(encodeCommand({ cmd: "prompt", text: "hello", qid: "q-1", mode: "auto" }));
    await until(() => events(f.out()).some((e) => e.ev === "done"));
    f.input.end();
    expect(await done).toBe(0);

    const all = events(f.out());
    expect(all.slice(0, 2).map((e) => e.ev)).toEqual(["session", "caps"]);
    expect(all.find((e) => e.ev === "caps")).toMatchObject({ modes: ["ask", "edits", "plan", "auto", "bypass"], compact: true, steer: true });
    expect(all.some((e) => e.ev === "taken" && (e as { qid: string }).qid === "q-1")).toBe(true);
    expect(all.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("all done here");
    expect(all.filter((e) => e.ev !== "synced").map((e) => e.seq)).toEqual(all.filter((e) => e.ev !== "synced").map((_, i) => i + 1));
    expect(f.err()).toBe(""); // stdout carries the protocol; stderr stays quiet
  });

  test("bad input never crashes the server: it answers with an error event and carries on", async () => {
    const { env } = setup();
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio"], f.io);
    f.input.push("not json\n");
    f.input.push('{"cmd":"explode"}\n');
    f.input.push('{"cmd":"prompt","text":"","mode":"yolo"}\n');
    f.input.push(encodeCommand({ cmd: "prompt", text: "still alive" }));
    await until(() => events(f.out()).some((e) => e.ev === "done"));
    f.input.end();
    await done;
    const errors = events(f.out()).filter((e) => e.ev === "error").map((e) => (e as { msg: string }).msg);
    expect(errors).toEqual([expect.stringMatching(/not valid JSON/), expect.stringMatching(/unknown command "explode"/), expect.stringMatching(/mode must be one of/)]);
  });

  test("commands split across chunks are reassembled; approvals round-trip in ask mode", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio", "--cwd", work], f.io);
    const line = encodeCommand({ cmd: "prompt", text: `write ${join(work, "a.txt")}`, mode: "ask" });
    f.input.push(line.slice(0, 15)); await wait(20); f.input.push(line.slice(15));
    await until(() => events(f.out()).some((e) => e.ev === "approval"));
    expect(existsSync(join(work, "a.txt"))).toBe(false);
    const card = events(f.out()).find((e) => e.ev === "approval") as unknown as { id: string };
    f.input.push(encodeCommand({ cmd: "approve", id: card.id, optionId: "allow" } as Command));
    await until(() => events(f.out()).some((e) => e.ev === "done"));
    f.input.end();
    await done;
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("hello from the agent\n");
  });

  test("a missing model is reported on the protocol and on stderr, exit 2", async () => {
    const f = fakeIO({ env: { HOME: tempDir() } });
    expect(await main(["serve", "--stdio"], f.io)).toBe(2);
    expect(events(f.out())[0]).toMatchObject({ ev: "error" });
    expect(f.err()).toMatch(/no model is connected yet/);
  });

  test("closing stdin mid-turn lets the turn finish first", async () => {
    const { env } = setup();
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio"], f.io);
    f.input.push(encodeCommand({ cmd: "prompt", text: "be held please" }));
    await until(() => mock.streaming() > 0);
    f.input.end();
    mock.release(); // the turn is still going when the input closes: it can only end now
    expect(await done).toBe(0);
    expect(events(f.out()).at(-1)).toMatchObject({ ev: "done", stop: "end_turn" });
  });
});

describe("interactive session", () => {
  test("talks, switches mode, shows help, and quits on /exit", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat", "--cwd", work], f.io);
    f.input.push("hello there\n");
    await until(() => f.out().includes("all done here"));
    f.input.push("/help\n/mode ask\n/mode bogus\n/session\n/nonsense\n/exit\n");
    expect(await done).toBe(0);
    expect(f.err()).toMatch(/Model\s+mock-model/);
    expect(f.err()).toMatch(/Mode\s+Auto/);
    expect(f.err()).toContain("Commands");
    expect(f.err()).toContain("Mode: Ask first");
    expect(f.err()).toMatch(/Mode now: Ask first\. Press Shift\+Tab to switch, or type one of: ask, edits, plan, auto, bypass\./);
    expect(f.err()).toMatch(/unknown command \/nonsense/);
    expect(f.err()).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // the session id
  });

  test("/clear while a reply is being written starts a new conversation, and the first goes on and says when it is done", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat", "--cwd", work], f.io);
    f.input.push("be slow please\n");
    await until(() => f.out().includes("thinking"));
    f.input.push("/clear\n");
    await until(() => f.err().includes("goes on in the background"));
    await until(() => f.err().includes("finished in the background"), 10_000);
    f.input.push("hello there\n");
    await until(() => f.out().includes("all done here"));
    f.input.push("/exit\n");
    expect(await done).toBe(0);
  });

  test("an approval is answered by typing y or n", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat", "--cwd", work, "--mode", "ask"], f.io);
    f.input.push(`write ${join(work, "n.txt")}\n`);
    await until(() => f.err().includes("approval needed"));
    f.input.push("n\n");
    await until(() => f.out().includes("denied"));
    expect(existsSync(join(work, "n.txt"))).toBe(false);
    f.input.push(`write ${join(work, "y.txt")}\n`);
    await until(() => (f.err().match(/approval needed/g) ?? []).length === 2);
    f.input.push("y\n");
    await until(() => existsSync(join(work, "y.txt")));
    f.input.push("/exit\n");
    await done;
  });

  test("plan → /go: the plan is proposed, then approved and carried out in the previous mode", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat", "--cwd", work], f.io);
    f.input.push("/go\n");
    await until(() => f.err().includes("there is no plan to approve"));
    f.input.push("/mode plan\nplan the change\n");
    await until(() => f.err().includes("Plan ready."));
    mock.requests.length = 0;
    f.input.push("/go\n");
    await until(() => mock.requests.length > 0);
    expect(JSON.stringify(mock.requests[0].body.messages.at(-1))).toContain("The plan is approved");
    expect(mock.requests[0].body.tools.map((t: any) => t.function.name)).toContain("Write"); // back out of plan mode
    f.input.push("/exit\n");
    await done;
  });

  test("/clear starts a new conversation; /compact reports when there is nothing to compact", async () => {
    const { env } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat"], f.io);
    f.input.push("/compact\n");
    await until(() => f.err().includes("Nothing to compact yet"));
    f.input.push("remember nine\n");
    await until(() => f.out().includes("all done here"));
    f.input.push("/clear\n");
    await until(() => f.err().includes("new conversation"));
    mock.requests.length = 0;
    f.input.push("what did I say\n");
    await until(() => mock.requests.length > 0);
    expect(JSON.stringify(mock.requests[0].body.messages)).not.toContain("remember nine");
    f.input.push("/exit\n");
    await done;
  });

  test("Ctrl+C while idle quits at once, without waiting for another keystroke", async () => {
    const { env } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat"], f.io);
    await until(f.listening);
    f.interrupt();
    // Quitting must not wait for another keystroke: a hang is what fails, not a slow machine.
    expect(await Promise.race([done, wait(20_000).then(() => "hung")])).toBe(0);
  });

  test("Ctrl+C during a turn cancels it and the session stays open", async () => {
    const { env } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat"], f.io);
    mock.requests.length = 0;
    f.input.push("be slow please\n");
    await until(() => mock.requests.length > 0);
    f.interrupt();
    await until(() => f.err().includes("Stopped"));
    f.input.push("hello again\n");
    await until(() => f.out().includes("all done here"));
    f.input.push("/exit\n");
    expect(await done).toBe(0);
  });

  test("a task given on the command line runs first; end of input quits", async () => {
    const { env } = setup();
    const f = fakeIO({ env, interactive: true, stdin: "" });
    expect(await main(["chat", "start with this"], f.io)).toBe(0);
    expect(f.out()).toContain("all done here");
  });

  test("with no model set up, the app still opens and the first message points to Providers", async () => {
    const f = fakeIO({ env: { HOME: tempDir() }, interactive: true, stdin: "hello\n" });
    expect(await main(["chat"], f.io)).toBe(0);
    expect(f.err()).toContain("No model connected yet");
    expect(f.err()).toContain("No model is connected yet.");
    expect(f.err()).toContain("Providers need a terminal");
  });

  test("with menus, a first run opens Providers by itself; once a model is in use the welcome is drawn again and the next message goes to it", async () => {
    const calls: string[] = [];
    const dock = (() => ({ refresh() {}, clear() { calls.push("clear"); }, release() {} })) as unknown as NonNullable<Parameters<typeof fakeIO>[0]>["dock"];
    const state = tempDir();
    const f = fakeIO({ env: { HOME: state, XDG_STATE_HOME: state }, interactive: true, stdin: "hello\n", dock });
    // What the person presses, in order: Custom Endpoints, Add endpoint, the name, the address, one model by hand, Save, then back out.
    const picks: (string | undefined)[] = ["Custom Endpoints", "Add endpoint", "Name", "Endpoint URL", "Add model", "Model", undefined, "Save", undefined, undefined];
    const typed = ["box", mock.url, "mock-model"];
    const titles: string[] = [];
    f.io.choose = async (title: string, items: { label: string }[]) => {
      titles.push(title);
      const want = picks.shift();
      return want === undefined ? undefined : items.findIndex((i) => i.label === want);
    };
    f.io.text = async () => typed.shift();
    await main(["chat"], f.io);
    expect(titles[0]).toBe("Providers");
    expect(calls).toEqual(["clear"]);
    expect(f.out() + f.err()).toContain("all done here");
  });

  test("/connect and /providers open Providers from inside the app", async () => {
    const f = fakeIO({ env: { HOME: tempDir() }, interactive: true, stdin: "/connect\n/providers\n" });
    expect(await main(["chat"], f.io)).toBe(0);
    expect(f.err().match(/Providers need a terminal/g)).toHaveLength(2);
    expect(f.err()).not.toContain("No model is connected yet.");
  });

  test("a blank line is ignored, not sent as a message", async () => {
    const { env } = setup();
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat"], f.io);
    mock.requests.length = 0;
    f.input.push("\n   \n");
    f.input.push("hello after the blanks\n");
    await until(() => f.out().includes("all done here"));
    expect(mock.requests).toHaveLength(1);
    f.input.push("/exit\n");
    await done;
  });
});
