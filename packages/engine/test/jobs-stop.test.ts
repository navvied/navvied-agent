import { afterAll, describe, expect, test } from "bun:test";
import { Jobs, stopAllJobs } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("closing what an engine started, and waiting until it has really gone", () => {
  const sleeper = (): string[] => process.platform === "win32" ? ["ping", "-n", "30", "127.0.0.1"] : ["sleep", "30"];

  test("stopped() resolves when the programs have exited, not when they were asked to", async () => {
    const jobs = new Jobs(() => undefined);
    const view = jobs.start(sleeper(), process.cwd(), "sleeper");
    expect(view.status).toBe("running");
    jobs.close();
    const t0 = Date.now();
    await jobs.stopped();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(jobs.list()[0]!.status).toBe("stopped");
    // Nothing of it is left: asking again does not wait.
    const t1 = Date.now();
    await jobs.stopped();
    expect(Date.now() - t1).toBeLessThan(100);
  }, 15_000);

  test("stopAllJobs() also waits for the commands of a Jobs that was closed a moment ago", async () => {
    const a = new Jobs(() => undefined), b = new Jobs(() => undefined);
    a.start(sleeper(), process.cwd(), "a");
    b.start(sleeper(), process.cwd(), "b");
    a.close();
    await stopAllJobs();
    expect(a.list()[0]!.status).toBe("stopped");
    expect(b.list()[0]!.status).toBe("stopped");
    b.close();
  }, 15_000);

  test.skipIf(process.platform === "win32" || !Bun.which("setsid"))("stopped() also waits for the end to be reported: a program's output can stay open after it has exited", async () => {
    const events: { status: string }[] = [];
    const jobs = new Jobs((e) => { if (e.ev === "job") events.push(e); });
    // A helper that left the program's group keeps the output open, so the end is only known once the stop gives up on it.
    const { id } = jobs.start(["sh", "-c", "setsid sleep 30 & echo helper started; exec sleep 30"], process.cwd(), "holds its output");
    let seen = "";
    await until(() => { seen += jobs.read(id)!.output; return seen.includes("helper started"); });
    jobs.close();
    await jobs.stopped();
    expect(events.at(-1)!.status).toBe("stopped");
    await stopAllJobs();
  }, 20_000);

  test("an engine's shutdown() closes it and waits for its commands, so its folder can be removed", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: process.platform === "win32" ? "ping -n 30 127.0.0.1" : "sleep 30", run_in_background: true } }] }));
    await r.turn(prompt("start it", { mode: "auto" }));
    expect(r.of("job").some((e) => e.status === "running")).toBe(true);
    const t0 = Date.now();
    await r.engine.shutdown();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.of("job").at(-1)!.status).not.toBe("running");
    r.cleanup();
  }, 20_000);
});
