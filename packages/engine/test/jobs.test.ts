import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { Jobs, defaultTools } from "../src/index.ts";
import { toolsFor } from "../src/permissions.ts";
import type { Tool, ToolContext } from "../src/types.ts";
import { until, wait } from "./helpers.ts";
import { stopAllJobs } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-jobs-"));
afterAll(hook("jobs removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }), HOOK_MS);

const node = (code: string): string[] => [process.execPath, "-e", code];
const tool = (name: string): Tool => defaultTools().find((t) => t.name === name)!;
const rig = () => {
  const events: EngineEvent[] = [];
  const jobs = new Jobs((e) => events.push(e));
  const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal, emit: (e) => events.push(e), allowPrivateNetwork: false, jobs };
  return { events, jobs, ctx };
};
const states = (events: EngineEvent[]) => events.filter((e) => e.ev === "job").map((e) => (e as { status: string }).status);

describe("stopping a command", () => {
  test.skipIf(process.platform === "win32")("it is stopped for the person even when something it started got away and keeps its output open", async () => {
    const { events, jobs } = rig();
    const job = jobs.start(["sh", "-c", "setsid sleep 7.31 & sleep 30"], dir, "escaper");
    await wait(300);
    const at = Date.now();
    jobs.stop(job.id);
    await until(() => states(events).includes("stopped"), 6000);
    expect(Date.now() - at).toBeLessThan(5000);
    expect(jobs.list()[0]).toMatchObject({ status: "stopped" });
    Bun.spawnSync(["pkill", "-f", "sleep 7.31"]);
  });
});

describe("background commands", () => {
  test("start at once, report output since the last read, and end with their exit code", async () => {
    const { events, jobs } = rig();
    const job = jobs.start(node("console.log('one'); setTimeout(() => { console.log('two'); process.exit(3); }, 300)"), dir, "demo");
    expect(job.status).toBe("running");
    await until(() => jobs.read(job.id)?.output.includes("one") ?? false);
    await until(() => jobs.list()[0]?.status === "failed");
    const r = jobs.read(job.id)!;
    expect(r.output).toContain("two");
    expect(r.output).not.toContain("one");
    expect(r.view.code).toBe(3);
    expect(states(events)).toEqual(["running", "failed"]);
    jobs.close();
  });
  test("a clean exit is done, and stopping a running one is stopped, once", async () => {
    const { events, jobs } = rig();
    const quick = jobs.start(node("console.log('ok')"), dir, "quick");
    const slow = jobs.start(node("setInterval(() => {}, 1000)"), dir, "slow");
    await until(() => jobs.list().find((j) => j.id === quick.id)?.status === "done");
    expect(jobs.running).toBe(1);
    expect(jobs.stop(slow.id)?.status).toBe("stopped");
    await until(() => states(events).includes("stopped"));
    expect(states(events).filter((s) => s === "stopped")).toEqual(["stopped"]);
    expect(jobs.stop("nope")).toBeUndefined();
    jobs.close();
  });
  test("a command that cannot start is reported, not thrown", async () => {
    const { jobs } = rig();
    const job = jobs.start(["navvied-no-such-program"], dir, "missing");
    await until(() => jobs.list()[0]?.status === "failed");
    expect(jobs.read(job.id)!.output).toContain("Error:");
    jobs.close();
  });
  test("output beyond the limit keeps the newest and says how much was dropped", async () => {
    const { jobs } = rig();
    const job = jobs.start(node("process.stdout.write('a'.repeat(500000)); process.stdout.write('END')"), dir, "loud");
    await until(() => jobs.list()[0]?.status === "done");
    const r = jobs.read(job.id)!;
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.output.endsWith("END")).toBe(true);
    expect(jobs.read(job.id)!.output).toBe("");
    jobs.close();
  });
});

describe("the Bash tools for background work", () => {
  test("Bash starts a job; BashOutput reads it; KillShell stops it", async () => {
    const { ctx, jobs } = rig();
    const started = await tool("Bash").run({ command: "echo hello-from-job; sleep 30", run_in_background: true, description: "demo" }, ctx);
    expect(started).toContain("job1");
    let out = "";
    for (let i = 0; i < 300 && !out.includes("hello-from-job"); i++) { out += await tool("BashOutput").run({ job_id: "job1" }, ctx); await wait(20); }
    expect(out).toContain("hello-from-job");
    expect(out).toContain("still running");
    expect(await tool("KillShell").run({ job_id: "job1" }, ctx)).toContain("job1");
    await until(() => jobs.running === 0);
    expect(await tool("BashOutput").run({ job_id: "job9" }, ctx)).toContain('no job "job9"');
    jobs.close();
  });
  test("the read and stop tools are offered only while something runs, and stop never in plan mode", () => {
    const all = defaultTools();
    const names = (mode: "auto" | "plan", jobs: number) => toolsFor(mode, all, { small: false, userText: "", jobs }).map((t) => t.name);
    expect(names("auto", 0)).not.toContain("BashOutput");
    expect(names("auto", 1)).toEqual(expect.arrayContaining(["BashOutput", "KillShell"]));
    expect(names("plan", 1)).toContain("BashOutput");
    expect(names("plan", 1)).not.toContain("KillShell");
  });
});
