import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/args.ts";

const ok = (argv: string[]) => { const r = parseArgs(argv); if (!r.ok) throw new Error(r.error); return r; };
const bad = (argv: string[]) => { const r = parseArgs(argv); if (r.ok) throw new Error("expected an error"); return r.error; };

describe("serve options", () => {
  test("--ready-line and --exit-when-stdin-closes are plain switches, and take no value", () => {
    expect(parseArgs(["serve", "--http", "--ready-line", "--exit-when-stdin-closes"])).toMatchObject({ ok: true, options: { readyLine: true, exitWhenStdinCloses: true } });
    expect(parseArgs(["serve", "--ready-line=1"]).ok).toBe(false);
  });
  test("--http, --port, --host, --web and a repeatable --allow-origin", () => {
    const r = parseArgs(["serve", "--http", "--port", "9000", "--host", "0.0.0.0", "--web", "/ui", "--allow-origin", "https://a.example", "--allow-origin=https://b.example"]);
    expect(r.ok && r.options).toMatchObject({ http: true, port: 9000, host: "0.0.0.0", web: "/ui", allowOrigins: ["https://a.example", "https://b.example"] });
  });
  test("a port outside 0 to 65535 is refused", () => {
    expect(parseArgs(["serve", "--http", "--port", "70000"])).toMatchObject({ ok: false });
    expect(parseArgs(["serve", "--http", "--port", "x"])).toMatchObject({ ok: false });
  });
});

describe("commands", () => {
  test("no arguments starts the interactive session", () => expect(ok([]).command).toBe("chat"));
  test("run takes the task from the remaining words", () => {
    const r = ok(["run", "fix", "the", "failing", "test"]);
    expect(r.command).toBe("run");
    expect(r.prompt).toBe("fix the failing test");
  });
  test("a quoted task stays one argument", () => expect(ok(["run", "add a --flag parser"]).prompt).toBe("add a --flag parser"));
  test("-- ends option parsing", () => expect(ok(["run", "--", "--mode", "is", "text"]).prompt).toBe("--mode is text"));
  test("serve, models, help, version", () => {
    expect(ok(["serve", "--stdio"]).command).toBe("serve");
    expect(ok(["models"]).command).toBe("models");
    expect(ok(["--help"]).command).toBe("help");
    expect(ok(["-h"]).command).toBe("help");
    expect(ok(["--version"]).command).toBe("version");
    expect(ok(["-v"]).command).toBe("version");
    expect(ok(["run", "x", "--help"]).command).toBe("help");
  });
  test("checkpoints and restore", () => {
    expect(ok(["checkpoints", "--session", "s1"]).command).toBe("checkpoints");
    const r = ok(["restore", "abc123", "--session", "s1", "--yes"]);
    expect(r).toMatchObject({ command: "restore", prompt: "abc123", options: { session: "s1", yes: true } });
    expect(bad(["checkpoints", "extra"])).toMatch(/does not take arguments/);
  });
  test("an unknown command is an error that points at --help", () => expect(bad(["deploy"])).toMatch(/unknown command "deploy".*--help/));
  test("commands that take no arguments refuse them", () => expect(bad(["models", "extra"])).toMatch(/does not take arguments/));
});

describe("options", () => {
  test("values by space or equals, short and long", () => {
    const r = ok(["run", "t", "--mode", "plan", "--effort=high", "-m", "local", "--cwd", "/work", "--session=abc", "--max-steps", "7", "--config=/c.json"]);
    expect(r.options).toMatchObject({ mode: "plan", effort: "high", model: "local", cwd: "/work", session: "abc", maxSteps: 7, config: "/c.json" });
  });
  test("flags", () => {
    const r = ok(["run", "t", "--json", "-y", "--thinking", "--no-color"]);
    expect(r.options).toMatchObject({ json: true, yes: true, thinking: true, color: false });
    expect(ok(["run", "t", "--color"]).options.color).toBe(true);
    expect(ok(["run", "t"]).options).toMatchObject({ json: false, yes: false, thinking: false });
  });
  test("options may come before the command words", () => {
    const r = ok(["--mode", "ask", "run", "do it"]);
    expect(r.command).toBe("run");
    expect(r.options.mode).toBe("ask");
  });
  test.each([
    [["run", "t", "--mode", "yolo"], /--mode must be one of ask, edits, plan, auto, bypass/],
    [["run", "t", "--effort", "extreme"], /--effort must be one of/],
    [["run", "t", "--max-steps", "0"], /positive whole number/],
    [["run", "t", "--max-steps", "2.5"], /positive whole number/],
    [["run", "t", "--max-steps", "abc"], /positive whole number/],
    [["run", "t", "--model"], /needs a value/],
    [["run", "t", "--model", "--json"], /needs a value/],
    [["run", "t", "--bogus"], /unknown option "--bogus"/],
    [["run", "t", "-z"], /unknown option "-z"/],
    [["run", "t", "--json=1"], /does not take a value/],
  ])("rejects %j", (argv, why) => expect(bad(argv as string[])).toMatch(why as RegExp));
});
