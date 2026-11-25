import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools, stopAllJobs } from "../src/index.ts";
import { splitBackground } from "../src/tools/shell-bg.ts";
import type { ToolContext } from "../src/types.ts";
import { until } from "./helpers.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-amp-"));
afterAll(hook("bash-ampersand removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const ctx = (jobs: Jobs): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs });
const posix = process.platform !== "win32";
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("an & that would background a statement", () => {
  test("is found only where the shell would use it", () => {
    const bg = (s: string) => splitBackground(s).filter((p) => p.background).map((p) => p.text.trim());
    expect(bg("srv &")).toEqual(["srv"]);
    expect(bg("srv > log 2>&1 &")).toEqual(["srv > log 2>&1"]);
    expect(bg("srv &\nsleep 1\ncurl x")).toEqual(["srv"]);
    expect(bg("a & b")).toEqual(["a"]);
    expect(bg("a && b &&\n c")).toEqual([]);
    expect(bg("a &> f; b >& f; c |& d")).toEqual([]);
    expect(bg('echo "a & b"; echo \'x &\'; echo a\\& # c &')).toEqual([]);
    expect(bg("x=$(srv &)\n(srv &)\nfor i in 1; do srv & done\nif t; then srv &\nfi")).toEqual([]);
    expect(bg("cat <<EOF\nsrv &\nEOF\nls")).toEqual([]);
    expect(bg("srv & # note\nls")).toEqual(["srv"]);
    expect(bg("bash build.sh > out 2>&1 &\npid=$!\nwait $pid")).toEqual([]);
    expect(bg("cd a\nsrv1 &\nsrv2 &")).toEqual(["srv1", "srv2"]);
  });

  test.skipIf(!posix)("a server started with & is a job that KillShell stops, and nothing stays alive", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs), pidFile = join(dir, "pid"), own = join(dir, "own.log");
    const out = await tool("Bash").run({ command: `sh -c 'echo $$ > ${pidFile}; exec sleep 300' > ${own} 2>&1 &\nsleep 0.3; echo go` }, c);
    expect(out).toContain("Started job1 in the background");
    expect(out).toContain("go");
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    await tool("KillShell").run({ job_id: "job1" }, c);
    await jobs.stopped();
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    jobs.close();
  }, 20_000);

  test.skipIf(!posix)("without a redirect its output is the job's own, with the same note the flag gives", async () => {
    const jobs = new Jobs(() => undefined);
    const out = await tool("Bash").run({ command: "echo hello-from-job &" }, ctx(jobs));
    expect(out).toMatch(/^Started job1 in the background\. The trailing & was left out/);
    await until(() => jobs.read("job1", true)!.output.includes("hello-from-job"));
    jobs.close();
  });
});
