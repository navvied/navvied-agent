import { ChildEnv } from "../src/process-start.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools, secretNames, stopAllJobs } from "../src/index.ts";
import { answers } from "../src/pty.ts";
import { registerSecrets } from "../src/redact.ts";
import type { Tool, ToolContext } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until, wait } from "./helpers.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-term3-"));
afterAll(hook("terminal-3 removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);
afterAll(cleanupAll, HOOK_MS);

const tool = (name: string): Tool => defaultTools().find((t) => t.name === name)!;
const ctx = (jobs: Jobs, more: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs, ...more });
const node = (code: string): string => `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(code)}`;
const bash = (command: string, more: Record<string, unknown> = {}, c: ToolContext = ctx(new Jobs(() => undefined))) => tool("Bash").run({ command, ...more }, c);
const posix = process.platform !== "win32";

describe("asking for a job again and again", () => {
  test("the second read in a row that finds nothing says once to wait, and a wait or until keeps working", async () => {
    const jobs = new Jobs(() => undefined, Date.now, { wake: true });
    const c = ctx(jobs);
    await bash(node("console.log('first'); setTimeout(() => { console.log('late line'); }, 1500); setTimeout(() => {}, 2500)"), { run_in_background: true }, c);
    const read = (a: Record<string, unknown> = {}) => tool("BashOutput").run({ job_id: "job1", ...a }, c);
    await until(() => (jobs.read("job1", true)?.output ?? "").includes("first") || true);
    await wait(200);
    expect(await read()).toContain("first");
    const second = await read();
    expect(second).toContain("(no new output)");
    expect(second).not.toContain("do not ask again");
    const third = await read();
    expect(third).toContain("Nothing new since your last two reads");
    expect(third).toContain("You are woken when it ends");
    expect(await read()).not.toContain("Nothing new");
    // Waiting is not asking again and again: it answers with the line, and `until` waits for its text.
    expect(await read({ until: "late line" })).toContain("late line");
    expect(await read({ wait: 1 })).not.toContain("Nothing new");
    jobs.close();
  }, 20_000);

  test("a job that does not wake the model is told how to wait instead", async () => {
    const jobs = new Jobs(() => undefined, Date.now, { wake: true });
    const c = ctx(jobs);
    await bash(node("setTimeout(() => {}, 3000)"), { run_in_background: true, notify: "off" }, c);
    await tool("BashOutput").run({ job_id: "job1" }, c);
    const r = await tool("BashOutput").run({ job_id: "job1" }, c);
    expect(r).toContain("It will not wake you");
    expect(r).toContain('"wait":60');
    jobs.close();
  }, 20_000);

  test("the sentences that start a job read as sentences", async () => {
    const quiet = new Jobs(() => undefined);
    const plain = await bash(node("0"), { run_in_background: true }, ctx(quiet));
    expect(plain).toMatch(/^Started job\d+ in the background\. Read what it prints with BashOutput \(job_id "job\d+"\), stop it with KillShell\.$/);
    const waking = new Jobs(() => undefined, Date.now, { wake: true });
    const said = await bash(node("0"), { run_in_background: true }, ctx(waking));
    expect(said).toContain('BashOutput (job_id "job1") reads what it prints, and KillShell stops it.');
    quiet.close(); waking.close();
  });

  test("what Bash says on starting depends on whether the host wakes the model", async () => {
    const quiet = new Jobs(() => undefined);
    expect(await bash(node("0"), { run_in_background: true }, ctx(quiet))).toContain("Read what it prints with BashOutput");
    const waking = new Jobs(() => undefined, Date.now, { wake: true });
    const said = await bash(node("0"), { run_in_background: true, notify: "ready" }, ctx(waking));
    expect(said).toContain('You are woken when it ends or prints a line with "ready"');
    expect(await bash(node("0"), { run_in_background: true, notify: "off" }, ctx(waking))).toContain("It will not wake you");
    quiet.close(); waking.close();
  });
});

describe("what a command inherits", () => {
  test("a key in this program's environment does not reach a command or a job; PATH and the rest do", async () => {
    process.env.NAVVIED_TEST_API_KEY = "sk-test-0123456789abcdefghij";
    process.env.NAVVIED_TEST_KEPT_TOKEN = "kept-0123456789abcdefghij";
    registerSecrets(["configured-key-0123456789"]);
    process.env.INNOCENT_NAME = "configured-key-0123456789";
    try {
      const env = ChildEnv.scrubbed(process.env, { keep: ["NAVVIED_TEST_KEPT_TOKEN"] });
      const jobs = new Jobs(() => undefined, Date.now, { env: () => env });
      const c = ctx(jobs, { env });
      const probe = (name: string) => `if [ -z "\${${name}+x}" ]; then echo ${name}=unset; else echo ${name}=set; fi`;
      const names = ["NAVVIED_TEST_API_KEY", "NAVVIED_TEST_KEPT_TOKEN", "INNOCENT_NAME", "PATH", "HOME"];
      const out = await bash(names.map(probe).join("; "), {}, c);
      expect(out.split("\n")).toEqual(["NAVVIED_TEST_API_KEY=unset", "NAVVIED_TEST_KEPT_TOKEN=set", "INNOCENT_NAME=unset", "PATH=set", "HOME=set"]);
      // A job starts from the same environment.
      await bash(probe("NAVVIED_TEST_API_KEY"), { run_in_background: true }, c);
      await until(() => jobs.list()[0]?.status === "done");
      expect(jobs.read("job1")!.output).toContain("NAVVIED_TEST_API_KEY=unset");
      jobs.close();
    } finally { delete process.env.NAVVIED_TEST_API_KEY; delete process.env.NAVVIED_TEST_KEPT_TOKEN; delete process.env.INNOCENT_NAME; }
  });

  test("through the engine: the names the program passes, and what it was configured with, are not in `env` of Bash", async () => {
    process.env.NAVVIED_TEST_SECRET_Z = "zzzz-0123456789abcdefghij";
    try {
      const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: "env" } }] }), { env: { drop: ["NAVVIED_TEST_SECRET_Z"] } });
      await r.turn(prompt("show env", { mode: "auto" }));
      const result = JSON.stringify(r.provider.requests.at(-1)!.messages.at(-1));
      expect(result).toContain("PATH=");
      expect(result).not.toContain("NAVVIED_TEST_SECRET_Z");
      r.cleanup();
    } finally { delete process.env.NAVVIED_TEST_SECRET_Z; }
  });

  test("the names that look like secrets are listed for the program to pass on", () => {
    expect(secretNames({ A_KEY: "1", B_TOKEN: "1", C_SECRET: "1", D_PASSWORD: "1", E_PASSWD: "1", F_CREDENTIALS: "1", PATH: "1", HOME: "1", SSH_AUTH_SOCK: "1", KEYBOARD: "1" })).toEqual(["A_KEY", "B_TOKEN", "C_SECRET", "D_PASSWORD", "E_PASSWD", "F_CREDENTIALS", "KEYBOARD"]);
  });

  test("a command is given TERM=dumb, a program you type to a real terminal", async () => {
    expect(await bash("echo $TERM")).toBe("dumb");
  });
});

describe.skipIf(!posix)("a program you type to has a terminal of its own", () => {
  test("it has a window size and TERM, answers the cursor question, and takes what is typed", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs);
    const script = `echo "TERM=$TERM"; stty size; printf '\\033[6n'; read -t 3 -s -d R pos; echo "POS=$pos"; read -p 'name? ' n; echo "hello $n"`;
    await bash(script, { interactive: true }, c);
    const seen = async (text: string): Promise<string> => {
      let all = "";
      await until(() => { all += jobs.read("job1", true)!.output; return all.includes(text); }, 8000);
      return all;
    };
    const first = await seen("name? ");
    expect(first).toContain("TERM=xterm-256color");
    expect(first).toContain("30 100");
    expect(first).toMatch(/POS=\S*1;1/);
    expect(jobs.type("job1", "bob\n")).toBe(true);
    expect(await seen("hello bob")).toContain("hello bob");
    await until(() => jobs.list()[0]?.status === "done");
    jobs.close();
  }, 20_000);

  test("it can be stopped with everything it started", async () => {
    const jobs = new Jobs(() => undefined);
    await bash("sleep 31.7 & sleep 31.8", { interactive: true }, ctx(jobs));
    await wait(300);
    jobs.stop("job1");
    await until(() => jobs.list()[0]?.status === "stopped");
    await wait(300);
    // A killed program may stay in the process table, unreaped, for a moment: it is not running.
    const left = Bun.spawnSync(["ps", "-eo", "stat,args"]).stdout.toString().split("\n").filter((l) => /sleep 31\.[78]/.test(l) && !l.startsWith("Z") && !l.includes("ps -eo"));
    expect(left).toEqual([]);
    jobs.close();
  });

  test("the questions a terminal is asked, and the answers", () => {
    expect(answers("abc\x1b[6ndef\x1b[c")).toBe("\x1b[1;1R\x1b[?1;2c");
    expect(answers("\x1b[18t", 80, 24)).toBe("\x1b[8;24;80t");
    expect(answers("plain text \x1b[31mred\x1b[0m")).toBe("");
  });
});

describe("output past what memory keeps", () => {
  test("the end is kept, the whole is in a file, and the model is told where", async () => {
    const out = await bash(node("const l = 'x'.repeat(99) + '\\n'; for (let i = 0; i < 12000; i++) process.stdout.write(i === 0 ? 'THE-START\\n' + l : l); process.stdout.write('THE-END\\n')"));
    expect(out).toContain("THE-END");
    const file = /saved in (\S+): read the part/.exec(out)?.[1];
    expect(file).toBeDefined();
    const whole = readFileSync(file!, "utf8");
    expect(whole.length).toBeGreaterThan(1_200_000);
    expect(whole.startsWith("THE-START")).toBe(true);
    expect(whole.trimEnd().endsWith("THE-END")).toBe(true);
  }, 30_000);

  test("a secret in a long output is not in the file", async () => {
    registerSecrets(["file-secret-0123456789"]);
    const out = await bash(node("process.stdout.write('file-secret-0123456789\\n'); const l = 'y'.repeat(99) + '\\n'; for (let i = 0; i < 12000; i++) process.stdout.write(l);"));
    const file = /saved in (\S+): read the part/.exec(out)?.[1]!;
    expect(readFileSync(file, "utf8")).not.toContain("file-secret-0123456789");
    expect(existsSync(file)).toBe(true);
  }, 30_000);
});

describe("what an exit says", () => {
  test.skipIf(!posix)("a program that is not there, a signal, and a pipe that hides a failure", async () => {
    expect(await bash("nosuchprogram_xyz --version")).toContain('[exit 127: "nosuchprogram_xyz" is not installed or not on PATH]');
    expect(await bash("exit 137")).toContain("[exit 137, SIGKILL: killed, often because the machine ran out of memory]");
    expect(await bash("exit 139")).toContain("[exit 139, SIGSEGV: it crashed (segmentation fault)]");
    expect(await bash("exit 143")).toContain("[exit 143, SIGTERM: asked to stop]");
    expect(await bash("kill -9 $$")).toContain("[SIGKILL: killed, often because the machine ran out of memory]");
    expect(await bash("exit 126")).toContain("[exit 126: found, but it cannot be run");
    expect(await bash("grep nothing /dev/null")).toContain("[exit 1: no matches, not a failure]");
    expect(await bash("env FOO=1 grep nothing /dev/null")).toContain("no matches, not a failure");
    expect(await bash("echo 'Error: build failed' | tail -1")).toContain('Run again with "set -o pipefail; "');
    expect(await bash("set -o pipefail; echo 'Error: build failed' | tail -1")).not.toContain("pipefail; ");
    expect(await bash("echo fine | tail -1")).toBe("fine");
  });
});
