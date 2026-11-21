import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import { Presenter, plainModelError, type PresenterOptions } from "../src/presenter.ts";
import { Renderer } from "../src/render.ts";
import { resolveTheme, setTheme } from "../src/theme.ts";
import { fakeIO } from "./helpers.ts";

beforeAll(() => setTheme(resolveTheme({ theme: "dark" }, { COLORTERM: "truecolor" })));
/** The theme is shared by every test file, so it is put back for the ones that run after this one. */
afterAll(() => setTheme(resolveTheme(null, {})));
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function rig(opts: { live?: boolean; color?: boolean; thinking?: boolean; display?: PresenterOptions["display"]; steps?: "list" | "fold" | "all" } = {}) {
  const f = fakeIO({ color: opts.color ?? false, interactive: true });
  const lives: string[][] = [];
  const io = { ...f.io, ...(opts.live === false ? {} : { live: (lines: readonly string[]) => { lives.push([...lines]); } }) };
  let now = 0;
  let tick: (() => void) | undefined;
  const presenter = new Presenter(io, new Renderer(io, { thinking: false }), {
    cwd: () => "/work/shop", thinking: opts.thinking ?? false, width: () => 60, now: () => now, every: (_ms, fn) => { tick = fn; return () => { tick = undefined; }; },
    ...(opts.display ? { display: opts.display } : {}), ...(opts.steps ? { steps: opts.steps } : {}),
  });
  const send = (...events: EngineEvent[]): void => { for (const e of events) presenter.handle(e); };
  return { presenter, send, shown: () => f.err(), lines: () => f.err().split("\n"), lives, lastLive: () => lives.at(-1) ?? [], advance: (ms: number) => { now += ms; tick?.(); }, ticking: () => tick !== undefined };
}

describe("the person's message", () => {
  test("is shown in a block of its own, with what they typed rather than what the engine was given", () => {
    const r = rig({ display: (qid) => (qid === "q1" ? "explain @a.ts" : undefined) });
    r.send({ ev: "user", qid: "q1", text: "explain @a.ts\n\n[file a.ts]\nsecret contents" });
    expect(r.shown()).toContain("You");
    expect(r.shown()).toContain("explain @a.ts");
    expect(r.shown()).not.toContain("secret contents");
  });
  test("a long message wraps inside the block and a very long one is cut with a count", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: `${"word ".repeat(30)}` });
    expect(r.lines().filter((l) => l.trim().startsWith("word")).length).toBeGreaterThan(1);
    expect(Math.max(...r.lines().map((l) => l.length))).toBeLessThanOrEqual(58);
    const big = rig();
    big.send({ ev: "user", qid: "q", text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") });
    expect(big.shown()).toContain("… 20 more lines");
  });
  test("with colour it is as plain as the answer: the ❯ of the prompt, You in the accent, the words under it", () => {
    const r = rig({ color: true });
    r.send({ ev: "user", qid: "q", text: "hi" });
    expect(r.shown()).toContain("\u001b[");
    const rows = r.lines().map(strip).filter((l) => l.trim());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("  ❯ You");
    expect(rows[1]).toBe("  hi");
  });
  test("without colour it is the same layout, plain", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "hi there" });
    const rows = r.lines().filter((l) => l.trim());
    expect(rows[0]!.trim()).toBe("❯ You");
    expect(rows[1]!.trim()).toBe("hi there");
  });
});

describe("a turn", () => {
  test("steps in plain words, the formatted answer, the mark once, and the time at the end", () => {
    const r = rig();
    r.send(
      { ev: "user", qid: "q", text: "why?" }, { ev: "taken", qid: "q" },
      { ev: "tool", id: "t1", name: "Read", status: "running", progress: 0 },
      { ev: "tool", id: "t1", name: "Read", status: "running", input: { file_path: "/work/shop/src/checkout.ts" } },
    );
    r.advance(1000);
    r.send({ ev: "tool", id: "t1", name: "Read", status: "done", output: "a\nb\nc" });
    r.send({ ev: "text", text: "## Cause\nIt adds `0.1 + 0.2`.\n\n- fix one\n" }, { ev: "text", text: "- fix two" });
    r.advance(5000);
    r.send({ ev: "done", stop: "end_turn" });
    const out = r.shown();
    expect(out.match(/⬢⬢ {2}navvied/g)).toHaveLength(1);
    expect(out).toContain("✓ Read src/checkout.ts  3 lines");
    expect(out).toContain("  Cause");
    expect(out).toContain("  It adds 0.1 + 0.2.");
    expect(out).toContain("  •  fix one");
    expect(out).toContain("  •  fix two");
    const rows = out.split("\n");
    const at = (needle: string): number => rows.findIndex((l) => l.includes(needle));
    expect(at("⚙ Work")).toBeGreaterThan(-1);
    expect(at("└ Read 1 file")).toBeGreaterThan(at("✓ Read src/checkout.ts"));
    expect(at("⬢⬢  navvied")).toBeGreaterThan(at("└ Read 1 file"));
    expect(at("  Cause")).toBeGreaterThan(at("⬢⬢  navvied"));
  });
  test("a change shows what came out and went in, numbered from the line the tool reported", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "tool", id: "t", name: "Edit", status: "running", input: { file_path: "/work/shop/a.ts", old_string: "return sum;", new_string: "// shown with two decimals\nreturn round(sum);" } });
    r.send({ ev: "tool", id: "t", name: "Edit", status: "done", output: "Edited /work/shop/a.ts at line 41 (1 replacement)." });
    const out = r.shown();
    expect(out).toContain("✓ Changed a.ts  2 lines added, 1 removed");
    expect(out).toContain("  41  − return sum;");
    expect(out).toContain("  41  + // shown with two decimals");
    expect(out).toContain("  42  + return round(sum);");
  });
  test("a step that failed says so plainly and shows the last lines it said", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "build" }, { ev: "tool", id: "t", name: "Bash", status: "running", input: { command: "npm run build" } });
    r.send({ ev: "tool", id: "t", name: "Bash", status: "done", output: "compiling\nerror TS2304: Cannot find name 'Cart'.\n[exit 2]" });
    const out = r.shown();
    expect(out).toContain("✗ The command failed: npm run build");
    expect(out).toContain("What it said");
    expect(out).toContain("error TS2304: Cannot find name 'Cart'.");
    expect(out).not.toContain("[exit 2]");
  });
  test("a tool that reports an error is shown as one that did not work", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "tool", id: "t", name: "Read", status: "running", input: { file_path: "/nope" } });
    r.send({ ev: "tool", id: "t", name: "Read", status: "error", output: "Error: /nope does not exist." });
    expect(r.shown()).toContain("✗ Could not read /nope");
    expect(r.shown()).toContain("/nope does not exist.");
  });
  test("stopping says so and what is left alone; an error shows the message", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "error", msg: "raphael did not answer" }, { ev: "done", stop: "cancelled" });
    expect(r.shown()).toContain("✗ Raphael did not answer");
    expect(r.shown()).toContain("■ Stopped  You pressed Esc. Nothing was undone");
  });
  test("thinking is summarised, and its text only appears when asked for", () => {
    const quiet = rig();
    quiet.send({ ev: "user", qid: "q", text: "x" }, { ev: "thought", text: "secret reasoning" });
    quiet.advance(3000);
    quiet.send({ ev: "text", text: "answer\n" });
    expect(quiet.shown()).toContain("▸ Thought for 3 s");
    expect(quiet.shown()).not.toContain("secret reasoning");
    const loud = rig({ thinking: true });
    loud.send({ ev: "user", qid: "q", text: "x" }, { ev: "thought", text: "secret reasoning" });
    expect(loud.shown()).toContain("secret reasoning");
  });
  test("a background job is shown when it ends (its start is the step that began it), and a question shows no line of its own", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "job", id: "job1", title: "npm run dev", status: "running" }, { ev: "approval", id: "a", title: "Run", options: [] }, { ev: "job", id: "job1", title: "npm run dev", status: "failed", code: 1 });
    expect(r.shown()).not.toContain("running in the background");
    expect(r.shown()).not.toContain("Waiting for your answer");
    expect(r.shown()).toContain("✗ npm run dev  stopped working, exit 1");
  });
  test("a call to the model that is made again is one quiet line, not a failure, and an event this program does not know shows nothing and breaks nothing", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "retry", reason: "the model asked to slow down", attempt: 3, of: 8, inSeconds: 2 }, { ev: "from_a_newer_engine" } as never);
    expect(r.shown()).toContain("The model asked to slow down. Trying again in 2 s (try 3 of 8).");
    expect(r.shown()).not.toContain("✗");
    expect(r.shown()).not.toContain("from_a_newer_engine");
  });
  test("a notice is a plain line that does not look like a failure", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "notice", msg: 'The connected program "notes" could not be used: could not start' });
    expect(r.shown()).toContain('! The connected program "notes" could not be used: could not start');
    expect(r.shown()).not.toContain("✗");
  });
  test("what the agent asks about is available for the question", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "tool", id: "t", name: "Edit", status: "running", input: { file_path: "a.ts", old_string: "a", new_string: "b" } });
    expect(r.presenter.pendingTool).toEqual({ name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } });
  });
});

describe("while it works", () => {
  test("a live line says what is happening and for how long, and moves on its own", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "tool", id: "t", name: "Write", status: "running", input: { file_path: "/work/shop/c.tsx" } });
    expect(strip(r.lastLive()[0]!)).toMatch(/^ {2}⠋ Writing c\.tsx…$/);
    r.advance(2000);
    expect(strip(r.lastLive()[0]!)).toMatch(/^ {2}⠙ Writing c\.tsx…  2 s$/);
    expect(r.ticking()).toBe(true);
    r.send({ ev: "done", stop: "end_turn" });
    expect(r.ticking()).toBe(false);
    expect(r.lastLive()).toEqual([]);
  });
  test("a message sent meanwhile waits under the line until it is taken in", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" });
    r.presenter.queue("q2", "also add it to the menu");
    expect(r.lastLive().map(strip)).toEqual([expect.stringContaining("Starting"), "", "  Next, after this step: also add it to the menu"]);
    r.send({ ev: "user", qid: "q2", text: "also add it to the menu" });
    expect(r.lastLive().some((l) => l.includes("Next, after"))).toBe(false);
    expect(r.shown()).toContain("also add it to the menu");
  });
  test("the answer being written shows as a live line until its line is complete", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "text", text: "Hel" });
    expect(r.lastLive()[0]).toBe("  Hel");
    expect(r.shown()).not.toContain("Hel");
    r.send({ ev: "text", text: "lo **there**\nnext" });
    expect(r.shown()).toContain("  Hello there");
    expect(r.lastLive()[0]).toBe("  next");
    r.send({ ev: "done", stop: "end_turn" });
    expect(r.shown()).toContain("  next");
  });
  test("making room while a long conversation is summarised is said in words", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "phase", name: "compacting" });
    expect(strip(r.lastLive()[0]!)).toContain("Compacting context");
  });
  test("without a whole-screen interface everything still comes out, line by line", () => {
    const r = rig({ live: false });
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "text", text: "one\ntw" }, { ev: "text", text: "o" }, { ev: "done", stop: "end_turn" });
    expect(r.shown()).toContain("  one\n");
    expect(r.shown()).toContain("  two\n");
    expect(r.lives).toEqual([]);
  });
});

describe("events it does not draw itself", () => {
  test("checkpoints go to the plain renderer", () => {
    const r = rig();
    r.send({ ev: "checkpoints", items: [{ id: "c1", at: 0, label: "Before: add a page", repos: ["shop"] }] });
    expect(r.shown()).toContain("Before: add a page");
  });
});

describe("a helper's steps", () => {
  test("are one quiet line each under the step that asked, in plain words, and do not take the live line", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "tool", id: "a", name: "Agent", status: "running", input: { description: "read the notes", prompt: "p" } });
    r.send({ ev: "tool", id: "a.r1", name: "Read", status: "running", input: { file_path: "/work/shop/notes.txt" }, parent: "a" }, { ev: "tool", id: "a.r1", name: "Read", status: "done", output: "x", parent: "a" });
    r.send({ ev: "tool", id: "a.r2", name: "Read", status: "running", input: { file_path: "/nope" }, parent: "a" }, { ev: "tool", id: "a.r2", name: "Read", status: "error", output: "Error: no such file", parent: "a" });
    expect(strip(r.lastLive()[0]!)).toContain("Asking a helper: read the notes");
    r.send({ ev: "tool", id: "a", name: "Agent", status: "done", output: "found it" });
    const rows = r.lines();
    const at = rows.findIndex((l) => l.includes("✓ Asked a helper: read the notes"));
    expect(at).toBeGreaterThan(-1);
    const nested = rows.filter((l) => l.startsWith("    │ "));
    expect(nested).toEqual(["    │ Read notes.txt", "    │ Could not read /nope"]);
  });
});

describe("spacing", () => {
  test("a paragraph and a step never touch: one blank line sits between them, and none inside a run of steps", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "text", text: "First I will look.\n" });
    r.send({ ev: "tool", id: "a", name: "Read", status: "running", input: { file_path: "a.ts" } }, { ev: "tool", id: "a", name: "Read", status: "done", output: "x" });
    r.send({ ev: "tool", id: "b", name: "Read", status: "running", input: { file_path: "b.ts" } }, { ev: "tool", id: "b", name: "Read", status: "done", output: "x" });
    r.send({ ev: "text", text: "Now the answer.\n" }, { ev: "done", stop: "end_turn" });
    const rows = r.lines();
    const at = (needle: string): number => rows.findIndex((l) => l.includes(needle));
    expect(rows[at("✓ Read a.ts") - 1]).toContain("⚙ Work");
    expect(rows[at("⚙ Work") - 1]).toBe("");
    expect(rows[at("✓ Read b.ts") - 1]).toContain("✓ Read a.ts");
    expect(rows[at("Now the answer.") - 1]).toBe("");
  });
});

describe("steps that say how they went", () => {
  const start = (r: ReturnType<typeof rig>, id: string, name: string, input: unknown) =>
    r.send({ ev: "tool", id, name, status: "running", input: input as never });

  test("a finished step shows how long it took on the right, with a note when its output was cut or the person changed the command", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    start(r, "a", "Bash", { command: "grep -rn x ." });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "lots\n[exit 0]", code: 0, ms: 420, truncated: true });
    start(r, "b", "Bash", { command: "rm -rf dist/cache" });
    start(r, "b", "Bash", { command: "rm -rf dist/cache/vite" });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "done", output: "[exit 0]", code: 0, ms: 12_300 });
    const out = r.shown();
    expect(out).toMatch(/✓ Ran grep -rn x \.\s+TRUNCATED\s+0\.4 s/);
    expect(out).toMatch(/✓ Ran rm -rf dist\/cache\/vite\s+EDITED\s+12 s/);
  });
  test("a failure shows its exit code and what it said; a refusal, a time-out, a stop, a skip and a background start each have their own mark", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    start(r, "f", "Bash", { command: "bun test" });
    r.send({ ev: "tool", id: "f", name: "Bash", status: "error", output: "1 fail\n[exit 1]", code: 1, ms: 1200 });
    start(r, "d", "Bash", { command: "rm -rf cache" });
    r.send({ ev: "tool", id: "d", name: "Bash", status: "error", output: "The user denied this action.", outcome: "denied", ms: 5 });
    start(r, "k", "Bash", { command: "rm -rf /" });
    r.send({ ev: "tool", id: "k", name: "Bash", status: "error", output: "Blocked: this would delete the whole home folder or the whole disk. navvied never does this.", outcome: "blocked" });
    start(r, "t", "Bash", { command: "bun test --watch" });
    r.send({ ev: "tool", id: "t", name: "Bash", status: "error", output: "[timed out after 120s and was killed]", outcome: "timeout", ms: 120_000 });
    start(r, "s", "Bash", { command: "sleep 99" });
    r.send({ ev: "tool", id: "s", name: "Bash", status: "error", output: "[interrupted]", outcome: "stopped", ms: 3000 });
    r.send({ ev: "tool", id: "z", name: "Bash", status: "error", output: "[interrupted]", outcome: "skipped" });
    start(r, "g", "Bash", { command: "bun run dev", run_in_background: true });
    r.send({ ev: "tool", id: "g", name: "Bash", status: "done", output: "Started job1", outcome: "background", ms: 30 });
    const out = r.shown();
    expect(out).toMatch(/✗ The command failed: bun test\s+exit 1\s+1\.2 s/);
    expect(out).toContain("1 fail");
    expect(out).toContain("− You said no: Ran rm -rf cache");
    expect(out).toContain("⊘ Blocked: Ran rm -rf /");
    expect(out).toContain("navvied never does this");
    expect(out).toMatch(/⏱ Ran bun test --watch\s+timed out {3}2 m 0 s/);
    expect(out).toMatch(/■ Stopped: Ran sleep 99\s+3\.0 s/);
    expect(out).toContain("» Skipped:");
    expect(out).toMatch(/◉ Ran bun run dev\s+running in the background/);
  });
  test("the turn closes with what it came to: counts first, then what did not go well, then how long", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    start(r, "r", "Read", { file_path: "/work/shop/a.ts" });
    r.send({ ev: "tool", id: "r", name: "Read", status: "done", output: "x", ms: 100 });
    for (const id of ["c1", "c2"]) { start(r, id, "Bash", { command: `echo ${id}` }); r.send({ ev: "tool", id, name: "Bash", status: "done", output: "[exit 0]", code: 0, ms: 50 }); }
    start(r, "bad", "Bash", { command: "false" });
    r.send({ ev: "tool", id: "bad", name: "Bash", status: "error", output: "[exit 1]", code: 1, ms: 50 });
    r.advance(8000);
    r.send({ ev: "done", stop: "end_turn" });
    expect(r.shown().trimEnd().split("\n").at(-1)).toBe("  └ Ran 3 commands, read 1 file, 1 failed   8.0 s");
  });
  test("while it works, what a command prints shows under the live line, and the steps that wait show as next", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "tool", id: "w", name: "Bash", status: "running", queued: true, input: { command: "bun run lint" } });
    r.send({ ev: "tool", id: "x", name: "Bash", status: "running", queued: true, input: { command: "bun run build" } });
    start(r, "p", "Bash", { command: "bun test" });
    r.send({ ev: "tool", id: "p", name: "Bash", status: "running", live: "line one\nline two\nline three\nline four\n" });
    const live = r.lastLive().join("\n");
    expect(live).toContain("Running bun test");
    expect(live).not.toContain("line one");
    expect(live).toContain("│ line two");
    expect(live).toContain("│ line four");
    expect(live).toContain("○ Next: bun run lint");
    expect(live).toContain("○ Next: bun run build");
    r.send({ ev: "tool", id: "w", name: "Bash", status: "running", input: { command: "bun run lint" } });
    expect(r.lastLive().join("\n")).not.toContain("○ Next: bun run lint");
  });
});

describe("the working line, the task list and what a command printed", () => {
  test("a finished command shows its first lines and how many more there are", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" }, { ev: "tool", id: "a", name: "Bash", status: "running", input: { command: "ls" } });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "one\ntwo\nthree\nfour\n[exit 0]", code: 0, ms: 10 });
    const out = r.shown();
    expect(out).toContain("⎿ one");
    expect(out).toContain("⎿ two");
    expect(out).not.toContain("⎿ three");
    expect(out).toContain("… 2 more lines");
    expect(out).not.toContain("[exit 0]");
  });
  test("the agent's task list shows under the working line, ticked as it goes, and goes when the turn ends", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "plan", entries: [{ title: "Read the code", status: "completed" }, { title: "Change the type", status: "in_progress" }, { title: "Build", status: "pending" }] });
    const live = r.lastLive().join("\n");
    expect(live).toContain("☑ Read the code");
    expect(live).toContain("◐ Change the type");
    expect(live).toContain("☐ Build");
    r.send({ ev: "done", stop: "end_turn" });
    expect(r.lastLive().join("\n")).not.toContain("Change the type");
  });
  test("the working line says how many steps are done", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" }, { ev: "tool", id: "a", name: "Read", status: "running", input: { file_path: "/work/shop/a.ts" } });
    r.send({ ev: "tool", id: "a", name: "Read", status: "done", output: "x", ms: 5 }, { ev: "tool", id: "b", name: "Bash", status: "running", input: { command: "sleep 9" } });
    r.advance(3000);
    expect(r.lastLive().join("\n")).toMatch(/1 step done {3}3 s/);
  });
});

describe("the full output of the last step", () => {
  test("is kept for /output, without the exit line, and the last step that printed is the one kept", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" }, { ev: "tool", id: "a", name: "Bash", status: "running", input: { command: "ls" } });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "one\ntwo\nthree\n[exit 0]", code: 0 });
    expect(r.presenter.lastOutput).toEqual({ title: "Ran ls", text: "one\ntwo\nthree" });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "running", input: { command: "true" } }, { ev: "tool", id: "b", name: "Bash", status: "done", output: "[exit 0]", code: 0 });
    expect(r.presenter.lastOutput?.title).toBe("Ran true");
  });
});

describe("the work and the report are apart", () => {
  test("steps sit in a block with a rail on the left that closes with what it came to, and the answer comes under its own label after it", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "tool", id: "a", name: "Read", status: "running", input: { file_path: "/work/shop/a.ts" } }, { ev: "tool", id: "a", name: "Read", status: "done", output: "x", ms: 50 });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "running", input: { command: "ls" } }, { ev: "tool", id: "b", name: "Bash", status: "done", output: "one\ntwo\n[exit 0]", code: 0, ms: 50 });
    r.send({ ev: "text", text: "All done.\n" }, { ev: "done", stop: "end_turn" });
    const rows = r.lines();
    const work = rows.findIndex((l) => l.includes("⚙ Work")), close = rows.findIndex((l) => l.includes("└ Ran 1 command, read 1 file")), report = rows.findIndex((l) => l.includes("⬢⬢  navvied"));
    expect(work).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(work);
    expect(report).toBeGreaterThan(close);
    for (const line of rows.slice(work + 1, close)) expect(line.startsWith("  │ ")).toBe(true);
    expect(rows.slice(report).some((l) => l.includes("All done."))).toBe(true);
  });
  test("a second round of steps after some words is a new block, and the report label comes back for the next words", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "tool", id: "a", name: "Read", status: "running", input: { file_path: "/work/shop/a.ts" } }, { ev: "tool", id: "a", name: "Read", status: "done", output: "x" });
    r.send({ ev: "text", text: "Looking good so far.\n" });
    r.send({ ev: "tool", id: "b", name: "Read", status: "running", input: { file_path: "/work/shop/b.ts" } }, { ev: "tool", id: "b", name: "Read", status: "done", output: "x" });
    r.send({ ev: "text", text: "Finished.\n" }, { ev: "done", stop: "end_turn" });
    const out = r.shown();
    expect(out.match(/⚙ Work/g)).toHaveLength(2);
    expect(out.match(/⬢⬢ {2}navvied/g)).toHaveLength(2);
  });
  test("every step of the turn is kept for /steps, with what it ran and all it printed, and a new message starts a new list", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "running", input: { command: "ls -la" } }, { ev: "tool", id: "a", name: "Bash", status: "done", output: "one\ntwo\nthree\n[exit 0]", code: 0, ms: 30 });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "running", input: { command: "false" } }, { ev: "tool", id: "b", name: "Bash", status: "error", output: "[exit 1]", code: 1, ms: 20 });
    expect(r.presenter.steps).toEqual([
      { title: "Ran ls -la", mark: "✓", ms: 30, input: "ls -la", output: "one\ntwo\nthree" },
      { title: "Ran false", mark: "✗", ms: 20, input: "false", output: "" },
    ]);
    r.send({ ev: "done", stop: "end_turn" }, { ev: "user", qid: "q2", text: "again" });
    expect(r.presenter.steps).toEqual([]);
  });
});

describe("the steps of a block, as a list or folded", () => {
  const start = (r: ReturnType<typeof rig>, id: string, name: string, input: unknown) =>
    r.send({ ev: "tool", id, name, status: "running", input: input as never });
  const work = (r: ReturnType<typeof rig>): void => {
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    start(r, "a", "Bash", { command: "ls" });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "x\n[exit 0]", code: 0, ms: 100 });
    start(r, "b", "Bash", { command: "bun test" });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "error", output: "boom\n[exit 1]", code: 1, ms: 200 });
    start(r, "c", "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" });
    r.send({ ev: "tool", id: "c", name: "Edit", status: "done", output: "ok", ms: 5 });
    r.send({ ev: "text", text: "All done.\n" }, { ev: "done", stop: "end_turn" });
  };
  test("successful steps fold into the header; failures and changes stay on the screen", () => {
    const r = rig({ steps: "fold" });
    work(r);
    const out = r.shown();
    expect(out).toMatch(/Work .*1 folded: Ctrl\+O/);
    expect(out).toContain("bun test");
    expect(out).toContain("a.ts");
    expect(out).not.toMatch(/Ran ls/);
    expect(r.presenter.steps.map((x) => x.title).join("|")).toMatch(/ls/);
  });
  test("as a list (the default), every step stays as one line and only a failure or a change shows more", () => {
    const r = rig({ steps: "list" });
    work(r);
    const out = r.shown();
    expect(out).toMatch(/✓ Ran ls/);
    expect(out).not.toMatch(/⎿/);
    expect(out).toContain("What it said");
    expect(out).toContain("Ctrl+O for details");
    expect(out).not.toContain("folded");
  });
  test("with steps set to all, every step stays on the screen", () => {
    const r = rig({ steps: "all" });
    work(r);
    expect(r.shown()).toMatch(/Ran ls/);
  });
  test("while it works, the live area lists the steps so far", () => {
    const r = rig({ steps: "list" });
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    start(r, "a", "Bash", { command: "ls" });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "x\n[exit 0]", code: 0, ms: 100 });
    start(r, "b", "Bash", { command: "pwd" });
    const live = r.lastLive().join("\n");
    expect(live).toMatch(/Work .*step/);
    expect(live).toMatch(/Ran ls/);
  });
});

describe("redirected steps", () => {
  test("usage does not clutter the live line or the block header with jargon, and a redirected step says it did not run", () => {
    const r = rig({ steps: "list" });
    r.send({ ev: "user", qid: "q", text: "go" }, { ev: "taken", qid: "q" });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "running", input: { command: "ls" } });
    r.send({ ev: "tool", id: "a", name: "Bash", status: "done", output: "x\n[exit 0]", code: 0, ms: 50 });
    r.send({ ev: "usage", ctx: 900, win: 32768, out: 1234, turn: { in: 900, out: 1234, calls: 1 } });
    r.send({ ev: "tool", id: "b", name: "Bash", status: "error", output: "[redirected]", outcome: "redirected", input: { command: "rm -rf x" } } as never);
    expect(r.lastLive().join("\n")).not.toContain("tokens");
    r.send({ ev: "text", text: "ok\n" }, { ev: "done", stop: "end_turn" });
    const out = r.shown();
    expect(out).not.toContain("tokens");
    expect(out).toMatch(/↪ Redirected, not run/);
  });
});

describe("common model errors, in plain words", () => {
  test("a wrong or missing key, a model that did not answer, and no way to reach it at all", () => {
    expect(plainModelError("the model endpoint answered 401: Incorrect API key provided.")).toBe("The model did not accept the key it was given. Check it, or run /model to connect a different one.");
    expect(plainModelError("the model server answered 403")).toBe("The model did not accept the key it was given. Check it, or run /model to connect a different one.");
    expect(plainModelError("the model endpoint answered 500")).toBe("The model did not answer properly just now. Try again in a moment.");
    expect(plainModelError("the model returned an empty answer")).toBe("The model sent back nothing. Try again, or run /model to choose another one.");
    expect(plainModelError("fetch failed")).toBe("Could not reach the model. Check that it is running, and your internet connection.");
    expect(plainModelError("connect ECONNREFUSED 127.0.0.1:11434")).toBe("Could not reach the model. Check that it is running, and your internet connection.");
  });
  test("anything navvied does not recognise is still shown, as a sentence", () => {
    expect(plainModelError("raphael did not answer")).toBe("Raphael did not answer");
    expect(plainModelError("the model did not start answering within 180 seconds. Check that x.local can be reached from this computer.")).toBe("The model did not start answering within 180 seconds. Check that x.local can be reached from this computer.");
  });
});

describe("a message with a picture or a file attached", () => {
  test("a picture is only ever a count; a file says what the engine made of it", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "what is in these", images: 2, files: [{ name: "report.pdf", kind: "pdf", pages: 12 }, { name: "notes.txt", kind: "text" }] });
    const out = r.shown();
    expect(out).toContain("2 pictures attached");
    expect(out).toContain("report.pdf (12 pages)");
    expect(out).toContain("notes.txt");
  });

  test("a refused file, or a scanned PDF, says why in the same line", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x", files: [{ name: "old.doc", kind: "refused", note: "this kind of document is not read yet" }, { name: "scan.pdf", kind: "pdf", note: "no text in this PDF (scanned pages)" }] });
    const out = r.shown();
    expect(out).toContain("✗ old.doc — this kind of document is not read yet");
    expect(out).toContain("scan.pdf — no text in this PDF (scanned pages)");
  });

  test("nothing attached, nothing extra shown", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "plain message" });
    expect(r.shown()).not.toContain("picture");
    expect(r.shown()).not.toContain("attached");
  });
});

