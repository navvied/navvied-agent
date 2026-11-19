import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import { forget } from "../src/tools/shell-state.ts";
import { run } from "../src/tools/util.ts";
import type { ToolContext } from "../src/types.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "navvied-terminal2-")));
afterAll(hook("terminal-2 removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }));
const bash = defaultTools().find((t) => t.name === "Bash")!;
const posix = process.platform !== "win32";
const rig = (extra: Partial<ToolContext> = {}) => {
  const jobs = new Jobs(() => undefined);
  const shell = {};
  const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs, shell, ...extra };
  return { ctx, jobs, shell, done: () => { jobs.close(); forget(shell); } };
};
const node = (code: string): string => `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(code)}`;

describe("a command is timed by its silence, not by the clock", () => {
  test("the silence it is given by default is 45 seconds, and the answer when it is exceeded says how to wait for a line", async () => {
    expect(bash.parameters.properties).toMatchObject({ timeout: { description: "seconds without output, 45 if not given" } });
    expect(bash.description.length + JSON.stringify(bash.parameters).length).toBeLessThanOrEqual(600);
    const { ctx, jobs, done } = rig();
    const started = Date.now();
    const out = await bash.run({ command: node("console.log('ready'); setTimeout(() => {}, 120000)"), timeout: 1 }, ctx);
    expect(out).toContain('(until:"text" waits for a line)');
    expect(Date.now() - started).toBeLessThan(10_000);
    jobs.stopAll();
    done();
  }, 30_000);

  test("one that keeps printing is not cut at the silence time, and one that goes quiet is handed on as a job", async () => {
    const { ctx, jobs, done } = rig();
    const busy = await bash.run({ command: node("let i = 0; const t = setInterval(() => { console.log('line', ++i); if (i === 6) { clearInterval(t); } }, 400)"), timeout: 1 }, ctx);
    expect(busy).toContain("line 6");
    expect(busy).not.toContain("still running");
    expect(jobs.list()).toEqual([]);
    const quiet = await bash.run({ command: node("console.log('start'); setTimeout(() => {}, 4000)"), timeout: 1 }, ctx);
    expect(quiet).toContain("start");
    expect(quiet).toContain("[still running as job1 after 1s without output:");
    done();
  }, 30_000);

  test("whatever it prints, the whole time is limited: past it the command is handed on, and the answer says it was the time", async () => {
    const r = await run([process.execPath, "-e", "setInterval(() => console.log('x'), 50)"], { cwd: dir, signal: new AbortController().signal, idleMs: 500, timeoutMs: 1200, onTimeout: () => true });
    expect(r).toMatchObject({ timedOut: true, ranOut: "time", adopted: true });
    const quiet = await run([process.execPath, "-e", "setTimeout(() => {}, 5000)"], { cwd: dir, signal: new AbortController().signal, idleMs: 400, timeoutMs: 3000, onTimeout: () => true });
    expect(quiet).toMatchObject({ ranOut: "silence", adopted: true });
  }, 30_000);
});

describe.skipIf(!posix)("the folder and the exports stay for the next command", () => {
  test("cd stays, and the answer says so once: when the folder changed", async () => {
    const { ctx, done } = rig();
    mkdirSync(join(dir, "sub/deeper"), { recursive: true });
    expect(await bash.run({ command: "cd sub && pwd" }, ctx)).toBe(`${join(dir, "sub")}\n[now in sub]`);
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(join(dir, "sub"));
    expect(await bash.run({ command: "cd deeper" }, ctx)).toBe("[now in sub/deeper]");
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(join(dir, "sub/deeper"));
    expect(await bash.run({ command: "cd ../.." }, ctx)).toBe("[now in the working folder]");
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(dir);
    done();
  });

  test("a cd outside the working folder lasts that one command, and the answer says where the next one starts", async () => {
    const { ctx, done } = rig();
    mkdirSync(join(dir, "inside"), { recursive: true });
    await bash.run({ command: "cd inside" }, ctx);
    expect(await bash.run({ command: "cd / && pwd" }, ctx)).toBe("/\n[stays in inside: a cd outside it lasts one command]");
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(join(dir, "inside"));
    done();
  });

  test("cwd is for one call and leaves the remembered folder as it was", async () => {
    const { ctx, done } = rig();
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    await bash.run({ command: "cd a" }, ctx);
    expect(await bash.run({ command: "pwd", cwd: "b" }, ctx)).toBe(join(dir, "b"));
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(join(dir, "a"));
    done();
  });

  test("an export stays, an unset goes, and only what a command changed is written down: never the rest of the environment", async () => {
    const { ctx, shell, done } = rig();
    process.env.NAVVIED_TEST_SECRET = "do-not-write-me-down";
    try {
      expect(await bash.run({ command: "export GREETING=hello; export WHO='big world'" }, ctx)).toBe("(no output)");
      expect(await bash.run({ command: 'echo "$GREETING $WHO $NAVVIED_TEST_SECRET"' }, ctx)).toBe("hello big world [hidden]");
      const saved = readFileSync(join((shell as { folder: string }).folder, "exports"), "utf8");
      expect(saved).toContain("GREETING");
      expect(saved).not.toContain("do-not-write-me-down");
      expect(saved).not.toContain("NAVVIED_TEST_SECRET");
      await bash.run({ command: "unset GREETING" }, ctx);
      expect(await bash.run({ command: 'echo "[$GREETING] $WHO"' }, ctx)).toBe("[] big world");
    } finally { delete process.env.NAVVIED_TEST_SECRET; done(); }
  });

  test("a command that ends with exit still leaves the folder and the exports, and its code is said", async () => {
    const { ctx, done } = rig();
    mkdirSync(join(dir, "gone"), { recursive: true });
    expect(await bash.run({ command: "cd gone; export LEFT=1; exit 3" }, ctx)).toBe("[now in gone]\n[exit 3]");
    expect(await bash.run({ command: "echo $LEFT; pwd" }, ctx)).toBe(`1\n${join(dir, "gone")}`);
    done();
  });

  test("a command in the background starts where the earlier ones ended", async () => {
    const { ctx, jobs, done } = rig();
    mkdirSync(join(dir, "bg"), { recursive: true });
    await bash.run({ command: "cd bg; export WHERE=here" }, ctx);
    await bash.run({ command: 'pwd; echo "$WHERE"', run_in_background: true }, ctx);
    await jobs.waitFor("job1", 5000, new AbortController().signal, "here");
    expect(jobs.read("job1")!.output).toBe(`${join(dir, "bg")}\nhere\n`);
    done();
  });

  test("a folder that has gone is not remembered into: the command starts in the working folder", async () => {
    const { ctx, done } = rig();
    mkdirSync(join(dir, "temp-folder"), { recursive: true });
    await bash.run({ command: "cd temp-folder" }, ctx);
    rmSync(join(dir, "temp-folder"), { recursive: true });
    expect(await bash.run({ command: "pwd" }, ctx)).toBe(dir);
    done();
  });

  test("closing the conversation takes the remembered state away", async () => {
    const { ctx, shell, done } = rig();
    await bash.run({ command: "export A=1" }, ctx);
    const folder = (shell as { folder: string }).folder;
    expect(existsSync(folder)).toBe(true);
    done();
    expect(existsSync(folder)).toBe(false);
  });
});

describe("what the model is shown of a result", () => {
  test("no output and success is said so; a failure carries its code; success carries none", async () => {
    const { ctx, done } = rig();
    expect(await bash.run({ command: "true" }, ctx)).toBe("(no output)");
    expect(await bash.run({ command: "echo hi" }, ctx)).toBe("hi");
    expect(await bash.run({ command: "exit 4" }, ctx)).toBe("[exit 4]");
    done();
  });
  test("the environment is fixed: no colour, no pager, a terminal that is dumb", async () => {
    const { ctx, done } = rig();
    const out = await bash.run({ command: node("console.log([process.env.NO_COLOR, process.env.TERM, process.env.PAGER, process.env.GIT_PAGER].join(','))") }, ctx);
    expect(out).toBe("1,dumb,cat,cat");
    done();
  });
  test("the share of the window decides how much is shown: little for a small window, the end gets most of it, and the whole is saved", async () => {
    const { ctx, done } = rig({ window: 8_000 });
    const out = await bash.run({ command: node("process.stdout.write('H'.repeat(4000) + 'M'.repeat(12000) + 'T'.repeat(4000))") }, ctx);
    expect(out.length).toBeLessThan(6_600);
    expect(out.startsWith("H".repeat(1700))).toBe(true);
    expect(out).toContain("characters omitted");
    expect(out).toContain("T".repeat(3900));
    const saved = /saved in (\S+):/.exec(out)?.[1];
    expect(saved).toBeDefined();
    expect(readFileSync(saved!, "utf8").length).toBe(20_000);
    rmSync(join(saved!, ".."), { recursive: true, force: true });
    const big = rig({ window: 1_000_000 });
    const whole = await bash.run({ command: node("process.stdout.write('x'.repeat(20000))") }, big.ctx);
    expect(whole).toBe("x".repeat(20_000));
    big.done();
    done();
  });
});
