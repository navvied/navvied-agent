import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX, Jobs, Sandbox, defaultTools, sandboxAbility, stopAllJobs } from "../src/index.ts";
import type { ToolContext } from "../src/types.ts";
import { until } from "./helpers.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-amp-"));
afterAll(hook("bash-ampersand removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const ctx = (jobs: Jobs, more: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs, ...more });
const posix = process.platform !== "win32";
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (file: string): number => Number(readFileSync(join(dir, file), "utf8").trim());
let n = 0;
const name = (): string => `amp${process.pid}x${Date.now() % 100000}x${n++}`;

describe("an & is the shell's own: the whole script runs as written, and what it leaves running is a job", () => {
  test.skipIf(!posix)("`cmd > log &` then `echo $! > pid` in one script: $! is the real process, and KillShell leaves nothing alive", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs), t = name();
    const out = await tool("Bash").run({ command: `sh -c 'echo $$ > ${t}.own; exec sleep 300' > ${t}.log 2>&1 &\necho $! > ${t}.pid\necho started` }, c);
    expect(out).toContain("started");
    expect(out).toContain("still runs as job1");
    expect(out).not.toContain("trailing &");
    await until(() => existsSync(join(dir, `${t}.own`)) && readFileSync(join(dir, `${t}.own`), "utf8").trim() !== "");
    expect(pidIn(`${t}.pid`)).toBe(pidIn(`${t}.own`));
    expect(alive(pidIn(`${t}.pid`))).toBe(true);
    expect(jobs.list().find((j) => j.id === "job1")?.status).toBe("running");
    await tool("KillShell").run({ job_id: "job1" }, c);
    await jobs.stopped();
    await until(() => !alive(pidIn(`${t}.pid`)));
    expect(jobs.list().find((j) => j.id === "job1")?.status).toBe("stopped");
    jobs.close();
  }, 30_000);

  test.skipIf(!posix)("a script that starts a worker, waits for it and stops it is one shell and leaves no job (the term-background-worker oracle)", async () => {
    const jobs = new Jobs(() => undefined);
    writeFileSync(join(dir, "worker.py"), 'import os, time\nopen("worker.pid", "w").write(str(os.getpid()))\nfor i in range(400):\n    open("heartbeat.log", "a").write("beat %d\\n" % i)\n    time.sleep(0.05)\n');
    const script = 'python3 worker.py &\npid=$!\nuntil [ "$(wc -l < heartbeat.log 2>/dev/null || echo 0)" -ge 8 ]; do sleep 0.1; done\nwc -l < heartbeat.log | tr -d " " > beats.txt\nkill $pid\nwait $pid 2>/dev/null\ntrue';
    const out = await tool("Bash").run({ command: script }, ctx(jobs));
    expect(out).not.toContain("still runs as");
    expect(Number(readFileSync(join(dir, "beats.txt"), "utf8"))).toBeGreaterThanOrEqual(8);
    expect(jobs.list()).toEqual([]);
    expect(alive(pidIn("worker.pid"))).toBe(false);
    jobs.close();
  }, 30_000);

  test.skipIf(!posix)("the subshell and group forms are caught too, as a job that is stopped with KillShell", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs);
    let id = 0;
    for (const form of [(t: string) => `( sleep 3${t} & )`, (t: string) => `{ sleep 3${t} & }`, (t: string) => `(sleep 3${t} > /dev/null 2>&1 &)`]) {
      const t = name().replace(/\D/g, "").slice(-8);
      const out = await tool("Bash").run({ command: form(t) }, c);
      id++;
      expect(out).toContain(`still runs as job${id}`);
      const mine = (): boolean => spawnSync("pgrep", ["-x", "-f", `sleep 3${t}`]).status === 0;
      expect(mine()).toBe(true);
      await tool("KillShell").run({ job_id: `job${id}` }, c);
      await jobs.stopped();
      await until(() => !mine());
    }
    jobs.close();
  }, 40_000);

  test.skipIf(!posix)("`pkill -f` of a name the script itself spells does not end the script", async () => {
    const jobs = new Jobs(() => undefined);
    const t = name().replace(/\D/g, "").slice(-8);
    const out = await tool("Bash").run({ command: `sleep 3${t} > /dev/null 2>&1 &\nsleep 0.2\npkill -f "sleep 3${t}"\nsleep 0.2\necho script-still-here` }, ctx(jobs));
    expect(out).toContain("script-still-here");
    expect(out).not.toContain("still runs as");
    jobs.close();
  }, 30_000);

  test.skipIf(!posix)("a background job whose script ends with & stays a running job while what it started runs", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs), t = name();
    const out = await tool("Bash").run({ command: `sh -c 'echo $$ > ${t}.own; exec sleep 300' &`, run_in_background: true }, c);
    expect(out).toMatch(/^Started job1 in the background\. /);
    expect(out).not.toContain("trailing &");
    await until(() => existsSync(join(dir, `${t}.own`)) && readFileSync(join(dir, `${t}.own`), "utf8").trim() !== "");
    await new Promise((r) => setTimeout(r, 400));
    expect(jobs.list()[0]?.status).toBe("running");
    await tool("KillShell").run({ job_id: "job1" }, c);
    await jobs.stopped();
    await until(() => !alive(pidIn(`${t}.own`)));
    jobs.close();
  }, 30_000);

  test.skipIf(!posix || sandboxAbility().how !== "bubblewrap")("confined, the sandbox line is said once, however many & the script has", async () => {
    const jobs = new Jobs(() => undefined);
    const sandbox = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: dir });
    const t = name().replace(/\D/g, "").slice(-8);
    const out = await tool("Bash").run({ command: `sleep 3${t} > /dev/null 2>&1 &\nsleep 4${t} > /dev/null 2>&1 &\necho both` }, ctx(jobs, { sandbox }));
    expect(out.match(/\[sandbox:/g)?.length).toBe(1);
    jobs.close();
    sandbox.close();
  }, 30_000);
});
