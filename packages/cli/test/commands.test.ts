import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvent } from "@navvied/protocol";
import { main } from "../src/main.ts";
import { fakeIO, remove, startMockModel, tempDir, until, wait } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

/** An isolated environment: the mock model, and state kept in a throw-away directory. */
function setup(extra: Record<string, string> = {}) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_API_KEY: "test-key", NAVVIED_WINDOW: "100000", ...extra };
  return { env, work, state };
}

describe("run", () => {
  test("does the task, prints the answer on stdout and the steps on stderr, exits 0", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env });
    const code = await main(["run", `write ${join(work, "out.txt")}`, "--cwd", work], f.io);
    expect(code).toBe(0);
    expect(readFileSync(join(work, "out.txt"), "utf8")).toBe("hello from the agent\n");
    expect(f.out()).toContain("done: Created");
    expect(f.err()).toContain("● Write");
    expect(f.err()).toContain("✓ Created");
    expect(f.err()).toMatch(/Context \d+%/);
    expect(mock.requests.at(-1).auth).toBe("Bearer test-key");
  });

  test("reads the task from standard input when piped", async () => {
    const { env } = setup();
    const f = fakeIO({ env, stdin: "explain the project\n" });
    expect(await main(["run"], f.io)).toBe(0);
    expect(f.out()).toBe("all done here\n");
  });

  test("no task → usage error, exit 2", async () => {
    const f = fakeIO({ env: setup().env, interactive: true });
    expect(await main(["run"], f.io)).toBe(2);
    expect(f.err()).toMatch(/no task given/);
  });

  test("a model failure → exit 1 with the error on stderr", async () => {
    const f = fakeIO({ env: setup().env });
    expect(await main(["run", "this should fail"], f.io)).toBe(1);
    expect(f.err()).toMatch(/error: the model endpoint answered 500: model is down/);
  });

  test("no model configured → exit 2 with the way out", async () => {
    const f = fakeIO({ env: { HOME: tempDir() } });
    expect(await main(["run", "x"], f.io)).toBe(2);
    expect(f.err()).toMatch(/no model is configured.*NAVVIED_BASE_URL/);
  });

  test("a bad --cwd is reported", async () => {
    const f = fakeIO({ env: setup().env });
    expect(await main(["run", "x", "--cwd", "/definitely/not/here"], f.io)).toBe(2);
    expect(f.err()).toMatch(/is not a directory/);
  });

  test("--json prints stamped protocol events, one per line, and nothing else on stdout", async () => {
    const { env } = setup();
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--json"], f.io)).toBe(0);
    const events = f.out().trim().split("\n").map((l) => { const r = parseEvent(l); if (!r.ok) throw new Error(r.error); return r.value; });
    expect(events[0]?.ev).toBe("session");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.ev === "text").map((e) => (e as { text: string }).text).join("")).toBe("all done here");
    expect(events.at(-1)).toMatchObject({ ev: "done", stop: "end_turn" });
  });

  describe("approvals without a person", () => {
    test("ask mode refuses by default and says how to allow", async () => {
      const { env, work } = setup();
      const f = fakeIO({ env });
      const code = await main(["run", `write ${join(work, "no.txt")}`, "--mode", "ask", "--cwd", work], f.io);
      expect(code).toBe(0);
      expect(existsSync(join(work, "no.txt"))).toBe(false);
      expect(f.err()).toMatch(/denied: no one to ask. Use --yes/);
    });
    test("--yes allows", async () => {
      const { env, work } = setup();
      const f = fakeIO({ env });
      expect(await main(["run", `write ${join(work, "yes.txt")}`, "--mode", "ask", "--yes", "--cwd", work], f.io)).toBe(0);
      expect(existsSync(join(work, "yes.txt"))).toBe(true);
    });
  });

  test("plan mode prints the plan and changes nothing", async () => {
    const { env, work } = setup();
    const f = fakeIO({ env });
    expect(await main(["run", "plan the change", "--mode", "plan", "--cwd", work], f.io)).toBe(0);
    expect(f.out()).toContain("1. First step");
    expect(f.err()).toContain("Plan ready.");
  });

  test("Ctrl+C cancels the turn and exits 130; the model is not left running", async () => {
    const { env } = setup();
    const f = fakeIO({ env });
    const p = main(["run", "be slow please"], f.io);
    await wait(300);
    f.interrupt();
    expect(await p).toBe(130);
    expect(f.err()).toContain("Stopped");
  });

  test("a second Ctrl+C gives up at once", async () => {
    const { env } = setup();
    const f = fakeIO({ env });
    const started = Date.now();
    const p = main(["run", "be slow please"], f.io);
    await wait(150);
    f.interrupt(); f.interrupt();
    expect(await p).toBe(130);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a saved session can be continued with --session", async () => {
    const { env } = setup();
    const first = fakeIO({ env });
    await main(["run", "remember seven", "--json"], first.io);
    const id = parseEvent(first.out().split("\n")[0]!);
    if (!id.ok || id.value.ev !== "session") throw new Error("no session event");
    mock.requests.length = 0;
    expect(await main(["run", "what was it", "--session", id.value.id], fakeIO({ env }).io)).toBe(0);
    expect(JSON.stringify(mock.requests[0].body.messages)).toContain("remember seven");
  });
});

describe("skills", () => {
  test("a project's skills and the person's own are listed to the model, which can load them", async () => {
    const { env, work, state } = setup();
    const own = join(state, "navvied", "skills", "tone");
    mkdirSync(own, { recursive: true });
    const config = join(state, "navvied", "config.json");
    writeFileSync(join(own, "SKILL.md"), "---\ndescription: How to write to customers\n---\nBe warm.");
    const mine = join(work, ".navvied", "skills", "release");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "---\ndescription: Cut a release\n---\nTag it.");
    writeFileSync(config, JSON.stringify({ default: "m", models: { m: { baseUrl: mock.url, model: "mock-model", apiKey: "k", window: 100000 } } }));
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--config", config, "--cwd", work], f.io)).toBe(0);
    const request = mock.requests.at(-1)!.body;
    const system = String(request.messages[0].content);
    expect(system).toContain("- release: Cut a release");
    expect(system).toContain("- tone: How to write to customers");
    expect((request.tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("Skill");
  });
});

describe("connected programs", () => {
  test("their tools are offered to the model from the first request, named by program and tool", async () => {
    const { env, work, state } = setup();
    const cfg = join(state, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ default: "m", models: { m: { baseUrl: mock.url, model: "mock-model", apiKey: "k", window: 100000 } }, mcp: { notes: { command: process.execPath, args: [join(import.meta.dir, "../../engine/test/fake-mcp.js")] }, gone: { command: "navvied-no-such-program" } } }));
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--config", cfg, "--cwd", work], f.io)).toBe(0);
    const offered = (mock.requests.at(-1)!.body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(["mcp__notes__echo", "mcp__notes__add_numbers"]));
    expect(f.err()).toContain('note: The connected program "gone" could not be used: could not start');
  });
});

describe("an external command-line agent as the model", () => {
  const FAKE = join(import.meta.dir, "../../stream-engine/test/fake-agent.ts");
  function external() {
    const { env, state, work } = setup({ NAVVIED_BASE_URL: "", NAVVIED_MODEL: "" });
    const cfg = join(state, "ext.json");
    writeFileSync(cfg, JSON.stringify({ default: "sub", models: { sub: { command: "bun", args: [FAKE], window: 50_000 } } }));
    return { env, cfg, work };
  }
  test("run works through the program the user signed in to; no tokens pass through navvied", async () => {
    const { env, cfg, work } = external();
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--config", cfg, "--cwd", work], f.io)).toBe(0);
    expect(f.out()).toBe("Hello\n");
    expect(f.err()).toMatch(/Context 0% \(110 of 50,000 tokens\)/);
  });
  test("the program is told it is navvied, and is given the project's standing instructions", async () => {
    const { env, cfg, work } = external();
    const log = join(work, "argv.log");
    writeFileSync(cfg, JSON.stringify({ default: "sub", models: { sub: { command: "bun", args: [FAKE], window: 50_000, env: { FAKE_ARGV_LOG: log } } } }));
    writeFileSync(join(work, "NAVVIED.md"), "Always answer in French.");
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--config", cfg, "--cwd", work], f.io)).toBe(0);
    const argv = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]!) as string[];
    const given = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    expect(given).toContain("You are navvied");
    expect(given).toContain("the model of the program the user is signed in to");
    expect(given).toContain("Always answer in French.");
  });
  test("plan mode uses the program's read-only mode and prints the plan", async () => {
    const { env, cfg, work } = external();
    const f = fakeIO({ env });
    expect(await main(["run", "plan the work", "--mode", "plan", "--config", cfg, "--cwd", work], f.io)).toBe(0);
    expect(f.out()).toContain("1. First");
    expect(f.err()).toContain("Plan ready.");
  });
  test("ask mode is not available and says so; exit 1", async () => {
    const { env, cfg, work } = external();
    const f = fakeIO({ env });
    expect(await main(["run", "hello", "--mode", "ask", "--config", cfg, "--cwd", work], f.io)).toBe(1);
    expect(f.err()).toMatch(/can only run in Auto or Plan/);
  });
  test("serve announces that capability set to the host", async () => {
    const { env, cfg, work } = external();
    const f = fakeIO({ env });
    const done = main(["serve", "--stdio", "--config", cfg, "--cwd", work], f.io);
    await wait(150);
    f.input.end();
    await done;
    const caps = f.out().trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.ev === "caps");
    expect(caps).toMatchObject({ modes: ["auto", "plan"], compact: false });
  });
  test("models lists it by its command", async () => {
    const { env, cfg } = external();
    const f = fakeIO({ env });
    expect(await main(["models", "--config", cfg], f.io)).toBe(0);
    expect(f.out()).toMatch(/\* sub  command: bun .*fake-agent\.ts  50,000 tokens/);
  });
});

describe("checkpoints", () => {
  const sh = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(args, { cwd }); if (r.exitCode !== 0) throw new Error(args.join(" ")); };
  function repo(work: string) {
    sh(work, "git", "init", "-q"); sh(work, "git", "config", "user.email", "t@t.invalid"); sh(work, "git", "config", "user.name", "t");
    writeFileSync(join(work, "a.txt"), "original\n"); sh(work, "git", "add", "-A"); sh(work, "git", "commit", "-qm", "init");
  }
  const SESSION = "11111111-2222-4333-8444-555555555555";

  test("a run is checkpointed; the subcommands list it and restore the code (preview first, then --yes)", async () => {
    const { env, work } = setup();
    repo(work);
    expect(await main(["run", `write ${join(work, "a.txt")}`, "--cwd", work, "--session", SESSION], fakeIO({ env }).io)).toBe(0);
    expect(readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello from the agent\n");

    const list = fakeIO({ env });
    expect(await main(["checkpoints", "--session", SESSION, "--cwd", work], list.io)).toBe(0);
    const id = /^\s+1\s+(\S+)\s+just now\s+write /.exec(list.err())?.[1];
    expect(id).toBeDefined();

    const preview = fakeIO({ env });
    expect(await main(["restore", id!, "--session", SESSION, "--cwd", work], preview.io)).toBe(0);
    expect(preview.err()).toContain("revert  a.txt");
    expect(preview.err()).toContain("preview only");
    expect(readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello from the agent\n");

    const apply = fakeIO({ env });
    expect(await main(["restore", id!, "--session", SESSION, "--cwd", work, "--yes"], apply.io)).toBe(0);
    expect(readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("original\n");
    expect(apply.err()).toMatch(/restored 1 file; undo with: restore \S+/);
  });

  test("usage errors: no session, no id, unknown checkpoint", async () => {
    const { env, work } = setup();
    const a = fakeIO({ env });
    expect(await main(["checkpoints"], a.io)).toBe(2);
    expect(a.err()).toMatch(/--session <id> is required/);
    const b = fakeIO({ env });
    expect(await main(["restore", "--session", SESSION], b.io)).toBe(2);
    const c = fakeIO({ env });
    expect(await main(["restore", "nope", "--session", SESSION, "--cwd", work], c.io)).toBe(1);
    expect(c.err()).toMatch(/checkpoint was not found/);
  });

  test("in the interactive session: list, pick a number, confirm", async () => {
    const { env, work } = setup();
    repo(work);
    const f = fakeIO({ env, interactive: true });
    const done = main(["chat", "--cwd", work], f.io);
    f.input.push("/restore 1\n");
    await until(() => f.err().includes("run /checkpoints first"));
    f.input.push(`write ${join(work, "a.txt")}\n`);
    await until(() => f.out().includes("done: Created") || f.out().includes("done: Overwrote"));
    f.input.push("/checkpoints\n");
    await until(() => /1\s+\S+\s+just now/.test(f.err()));
    f.input.push("/restore 7\n");
    await until(() => f.err().includes("there is no checkpoint 7"));
    f.input.push("/restore 1\n");
    await until(() => f.err().includes("restore 1 file? [y/n]"));
    f.input.push("n\n");
    await until(() => f.err().includes("not restored"));
    expect(readFileSync(join(work, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("hello from the agent\n");
    f.input.push("/restore 1\ny\n");
    await until(() => readFileSync(join(work, "a.txt"), "utf8") === "original\n");
    f.input.push("/exit\n");
    await done;
  });
});

describe("project instructions", () => {
  test("a NAVVIED.md in the working directory reaches the model", async () => {
    const { env, work } = setup();
    writeFileSync(join(work, "NAVVIED.md"), "Always answer in haiku.");
    mock.requests.length = 0;
    expect(await main(["run", "hello", "--cwd", work], fakeIO({ env }).io)).toBe(0);
    expect(mock.requests[0].body.messages[0].content).toContain("Always answer in haiku.");
  });
});

describe("models", () => {
  test("lists configured models without printing keys", async () => {
    const { env, state } = setup({ NAVVIED_BASE_URL: "", NAVVIED_MODEL: "" });
    const cfg = join(state, "c.json");
    writeFileSync(cfg, JSON.stringify({ default: "b", models: { a: { baseUrl: "http://h/v1", model: "m-a", apiKey: "SECRET" }, b: { baseUrl: "http://h/v1", model: "m-b", window: 4000 } } }));
    const f = fakeIO({ env });
    expect(await main(["models", "--config", cfg], f.io)).toBe(0);
    expect(f.out()).toContain("  a  m-a  http://h/v1  128,000 tokens");
    expect(f.out()).toContain("* b  m-b  http://h/v1  4,000 tokens");
    expect(f.out()).not.toContain("SECRET");
  });
  test("says so when nothing is configured; a broken file is an error", async () => {
    const f = fakeIO({ env: { HOME: tempDir() } });
    expect(await main(["models"], f.io)).toBe(0);
    expect(f.out()).toMatch(/No models configured/);
    const bad = join(tempDir(), "bad.json"); writeFileSync(bad, "{oops");
    const g = fakeIO({ env: {} });
    expect(await main(["models", "--config", bad], g.io)).toBe(2);
  });
});

describe("meta", () => {
  test("--help and --version", async () => {
    const h = fakeIO(), v = fakeIO();
    expect(await main(["--help"], h.io)).toBe(0);
    expect(h.out()).toMatch(/Usage[\s\S]*navvied run "<task>"[\s\S]*Exit codes/);
    expect(await main(["--version"], v.io)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
  test("a usage error exits 2", async () => {
    const f = fakeIO();
    expect(await main(["run", "x", "--mode", "yolo"], f.io)).toBe(2);
    expect(f.err()).toMatch(/error: --mode must be one of/);
  });
});
