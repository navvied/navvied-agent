import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import type { ToolContext } from "../src/types.ts";
import { until } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-quiet-"));
afterAll(hook("bash-quiet removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);
const bash = defaultTools().find((t) => t.name === "Bash")!;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...extra });
const posix = process.platform !== "win32";

describe("a command that nobody can type to", () => {
  test.skipIf(!posix)("a program that reads its input ends at once instead of waiting out the timeout", async () => {
    const started = Date.now();
    const out = await bash.run({ command: "cat; echo after" }, ctx());
    expect(out).toContain("after");
    expect(out).not.toContain("[exit");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test.skipIf(!posix)("a command that leaves something running behind it (a trailing &) is answered when the command ends", async () => {
    const started = Date.now();
    const out = await bash.run({ command: "sleep 20 & echo started" }, ctx());
    expect(out).toContain("started");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test.skipIf(!posix)("git is told not to open an editor or ask for a password", async () => {
    const out = await bash.run({ command: 'echo "$GIT_EDITOR $GIT_TERMINAL_PROMPT"' }, ctx());
    expect(out).toContain("true 0");
  });

  test("output that does not fit is kept whole in a file the model can read", async () => {
    const out = await bash.run({ command: `${JSON.stringify(process.execPath)} -e "console.log('x'.repeat(100000))"` }, ctx());
    expect(out).toContain("characters omitted");
    const file = /saved in (\S+):/.exec(out)?.[1];
    expect(file).toBeDefined();
    expect(readFileSync(file!, "utf8").trim().length).toBe(100000);
    rmSync(join(file!, ".."), { recursive: true, force: true });
  });

  test("a conversation held to a folder gets no file outside it", async () => {
    const out = await bash.run({ command: `${JSON.stringify(process.execPath)} -e "console.log('x'.repeat(100000))"` }, ctx({ root: dir }));
    expect(out).toContain("characters omitted");
    expect(out).not.toContain("saved in");
  });

  test.skipIf(!posix)("background commands stop when the program is told to stop", async () => {
    const script = join(dir, "host.ts");
    writeFileSync(script, `import { Jobs } from ${JSON.stringify(join(import.meta.dir, "../src/index.ts"))};\nconst jobs = new Jobs(() => undefined);\nconst job = jobs.start(["sleep", "59.77"], process.cwd(), "demo");\nconsole.log("ready");\nsetInterval(() => {}, 1000);\n`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", cwd: dir });
    const reader = child.stdout.getReader();
    await reader.read();
    const running = (): string => Bun.spawnSync(["pgrep", "-f", "sleep 59.77"]).stdout.toString().trim();
    // "ready" is printed as the command is started; the program itself may not have taken its name yet on a busy machine.
    await until(() => running() !== "", 15_000);
    child.kill("SIGTERM");
    await child.exited;
    await until(() => running() === "", 15_000);
    expect(running()).toBe("");
  }, 40_000);
});

describe("what the model is shown of a command", () => {
  test.skipIf(!posix)("colour codes are gone and a progress line shows only its last state", async () => {
    const out = await bash.run({ command: `printf '\\033[31mred\\033[0m\\nprogress 10%%\\rprogress 55%%\\rprogress 100%%\\ndone\\n'` }, ctx());
    expect(out).toContain("red");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("progress 100%");
    expect(out).not.toContain("progress 10%");
  });

  test.skipIf(!posix)("exit 1 of grep, diff and test is said to be an answer, and other failures are not softened", async () => {
    expect(await bash.run({ command: "echo a | grep zzz" }, ctx())).toContain("[exit 1: no matches, not a failure]");
    expect(await bash.run({ command: "test -f /nonexistent-file" }, ctx())).toContain("[exit 1: the condition is false, not a failure]");
    expect(await bash.run({ command: "ls /nonexistent-dir-x" }, ctx())).toMatch(/\[exit [12]\]/);
    expect(await bash.run({ command: "false" }, ctx())).toContain("[exit 1]");
  });

  test.skipIf(!posix)("BashOutput can wait for the next output, and returns when the command ends", async () => {
    const c = ctx();
    const started = await bash.run({ command: "sleep 1; echo ready; sleep 0.2", run_in_background: true }, c);
    const id = /job\d+/.exec(started)![0];
    const output = defaultTools().find((t) => t.name === "BashOutput")!;
    const t0 = Date.now();
    const got = await output.run({ job_id: id, wait: 10 }, c);
    expect(got).toContain("ready");
    expect(Date.now() - t0).toBeGreaterThan(500);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const end = await output.run({ job_id: id, wait: 10 }, c);
    expect(end).toContain("done");
    c.jobs.stopAll();
  });
});

describe("a program you type to", () => {
  const typeTool = defaultTools().find((t) => t.name === "BashInput")!;
  const output = defaultTools().find((t) => t.name === "BashOutput")!;
  const hasPython = Bun.which("python3") !== null && Bun.which("script") !== null;

  test("BashInput is offered only while a program that can be typed to is running", async () => {
    const { toolsFor } = await import("../src/permissions.ts");
    const all = defaultTools();
    const names = (typable: number) => toolsFor("auto", all, { small: false, userText: "", jobs: typable, typable }).map((t) => t.name);
    expect(names(0)).not.toContain("BashInput");
    expect(names(1)).toContain("BashInput");
  });

  test.skipIf(!posix)("a program that asks a question gets its answer, and the reply can be read", async () => {
    const c = ctx();
    const started = await bash.run({ command: `read -p "name? " n; echo "hello $n"; read -p "again? " m; echo "bye $m"`, interactive: true }, c);
    const id = /job\d+/.exec(started)![0];
    expect(c.jobs.typable).toBe(1);
    expect(await output.run({ job_id: id, wait: 3 }, c)).toContain("name?");
    expect(await typeTool.run({ job_id: id, text: "world" }, c)).toContain("Typed to");
    expect(await output.run({ job_id: id, wait: 3 }, c)).toContain("hello world");
    await typeTool.run({ job_id: id, text: "ok" }, c);
    const last = await output.run({ job_id: id, wait: 5 }, c);
    expect(last).toContain("bye ok");
    c.jobs.stopAll();
  });

  test.skipIf(!posix || !hasPython)("a REPL runs in a terminal, so it prompts and answers as it would for a person", async () => {
    const c = ctx();
    const started = await bash.run({ command: "python3 -q", interactive: true }, c);
    const id = /job\d+/.exec(started)![0];
    await typeTool.run({ job_id: id, text: "print(6*7)" }, c);
    // The first thing that arrives may be the typed line coming back; the answer follows: read until it is there, as a model would.
    let seen = "";
    for (let i = 0; i < 20 && !seen.includes("42"); i++) seen += await output.run({ job_id: id, wait: 3 }, c);
    expect(seen).toContain("42");
    await typeTool.run({ job_id: id, text: "exit()" }, c);
    await output.run({ job_id: id, wait: 5 }, c);
    c.jobs.stopAll();
  });

  test("typing to a job that is not interactive, or does not exist, is a sentence", async () => {
    const c = ctx();
    expect(await typeTool.run({ job_id: "job9", text: "x" }, c)).toContain("no job");
    const plain = await bash.run({ command: "sleep 5", run_in_background: true }, c);
    const id = /job\d+/.exec(plain)![0];
    expect(await typeTool.run({ job_id: id, text: "x" }, c)).toContain("cannot be typed to");
    c.jobs.stopAll();
  });

  test("a program you type to does not run on a container or another computer", async () => {
    const out = await bash.run({ command: "python3 -q", interactive: true }, ctx({ backend: { id: "ssh", prepare: (command, cwd) => ({ argv: ["ssh", "x", command], cwd }) } }));
    expect(out).toContain("runs on this computer only");
  });
});
