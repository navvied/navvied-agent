import { afterAll, describe, expect, test } from "bun:test";
import { Jobs, defaultTools } from "../src/index.ts";
import { MOST_JOBS } from "../src/jobs.ts";
import type { ToolContext } from "../src/types.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll);
const node = (code: string): string[] => [process.execPath, "-e", code];
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("not in time"); await Bun.sleep(20); } };

describe("the news of a command that ended", () => {
  test("a job that ended is news once, a running one is not, and what was read or told is not news again", async () => {
    const jobs = new Jobs(() => undefined);
    jobs.start(node("setTimeout(() => {}, 5000)"), process.cwd(), "slow");
    jobs.start(node("console.log('a')"), process.cwd(), "quick one");
    jobs.start(node("process.exit(3)"), process.cwd(), "fails");
    await waitFor(() => jobs.news().length === 2);
    const news = jobs.news();
    expect(news.map((n) => [n.id, n.status, n.code])).toEqual([["job2", "done", 0], ["job3", "failed", 3]]);
    expect(news[0]!.ms).toBeGreaterThanOrEqual(0);
    expect(jobs.news().length).toBe(2);
    jobs.told(["job2"]);
    expect(jobs.news().map((n) => n.id)).toEqual(["job3"]);
    jobs.read("job3");
    expect(jobs.news()).toEqual([]);
    jobs.close();
  });
  test("a job that is stopped is news too, and a job that ended before anyone looked is not lost", async () => {
    const jobs = new Jobs(() => undefined);
    jobs.start(node("setTimeout(() => {}, 5000)"), process.cwd(), "slow");
    jobs.stop("job1");
    await waitFor(() => jobs.news().length === 1);
    await Bun.sleep(300);
    expect(jobs.news().map((n) => [n.id, n.status])).toEqual([["job1", "stopped"]]);
    jobs.close();
  });
});

describe("the news reaches the model, once", () => {
  const lines = (r: ReturnType<typeof rig>): string[] => r.provider.requests.map((q) => q.system.split("\n").find((l) => l.startsWith("[job1")) ?? "");
  test("the next request after the job ended says so; the one after that does not", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "ok" } : req.messages.filter((m) => m.role === "user").length === 1 ? { calls: [{ name: "Bash", args: { command: "sleep 0.3; echo hi", run_in_background: true } }] } : { text: "fine" }));
    await r.turn(prompt("start it", { mode: "auto" }));
    await Bun.sleep(900);
    await r.turn(prompt("what now", { mode: "auto" }));
    await r.turn(prompt("and now", { mode: "auto" }));
    const told = lines(r).filter(Boolean);
    expect(told.length).toBe(1);
    expect(told[0]).toMatch(/^\[job1 finished: exit 0, \d\.\d s; BashOutput job1 for the rest\]$/);
    r.cleanup();
  }, 30_000);
  test("a model that read the job itself is not told again", async () => {
    let n = 0;
    const r = rig((req) => {
      if (req.messages.at(-1)?.role === "tool") return { text: "ok" };
      n += 1;
      if (n === 1) return { calls: [{ name: "Bash", args: { command: "echo hi", run_in_background: true } }] };
      if (n === 2) return { calls: [{ name: "BashOutput", args: { job_id: "job1", wait: 5 } }] };
      return { text: "fine" };
    });
    await r.turn(prompt("start it", { mode: "auto" }));
    await Bun.sleep(400);
    await r.turn(prompt("read it", { mode: "auto" }));
    await r.turn(prompt("again", { mode: "auto" }));
    expect(lines(r).filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(r.provider.requests.at(-1)!.system).not.toContain("[job1");
    r.cleanup();
  }, 30_000);
});

describe("how many commands are kept", () => {
  const ctx = (jobs: Jobs): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs });
  test("when all of the most are running, another is refused with the way to make room", async () => {
    const jobs = new Jobs(() => undefined);
    const c = ctx(jobs);
    for (let i = 0; i < MOST_JOBS; i++) await tool("Bash").run({ command: `sleep ${20 + i}`, run_in_background: true, description: `sleeper ${i}` }, c);
    const refused = await tool("Bash").run({ command: "echo more", run_in_background: true }, c);
    expect(refused).toBe(`Error: ${MOST_JOBS} commands are already running in the background. Stop one with KillShell first (job1, the oldest, is "sleeper 0"): KillShell {"job_id": "job1"}. Then start this again.`);
    expect(jobs.list().length).toBe(MOST_JOBS);
    expect(await tool("Bash").run({ command: "python3 -q", interactive: true }, c)).toContain("already running in the background");
    await tool("KillShell").run({ job_id: "job1" }, c);
    await waitFor(() => jobs.list()[0]!.status !== "running");
    expect(await tool("Bash").run({ command: "echo room", run_in_background: true }, c)).toContain("Started job17");
    jobs.close();
  }, 30_000);
  test("finished ones are forgotten, the oldest first, to make room, and running ones never are", async () => {
    const jobs = new Jobs(() => undefined);
    for (let i = 0; i < MOST_JOBS; i++) jobs.start(node(i === 5 ? "setTimeout(() => {}, 20000)" : "0"), process.cwd(), `job number ${i}`);
    await waitFor(() => jobs.list().filter((j) => j.status !== "running").length === MOST_JOBS - 1);
    expect(jobs.room()).toBeUndefined();
    expect(jobs.list().length).toBe(MOST_JOBS - 1);
    expect(jobs.list().some((j) => j.id === "job6")).toBe(true);
    expect(jobs.list().some((j) => j.id === "job1")).toBe(false);
    jobs.close();
  }, 30_000);
});
