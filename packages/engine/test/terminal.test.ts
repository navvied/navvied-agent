import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import { portsIn } from "../src/jobs.ts";
import type { ToolContext } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-terminal-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const tool = (name: string) => defaultTools().find((t) => t.name === name)!;
const rig = (extra: Partial<ToolContext> = {}) => {
  const events: { ev: string; status?: string }[] = [];
  const jobs = new Jobs((e) => events.push(e as { ev: string; status?: string }));
  const ctx: ToolContext = { cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs, ...extra };
  return { jobs, ctx, events };
};
const posix = process.platform !== "win32";
const node = (code: string): string => `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(code)}`;

describe("a command that is not done in time", () => {
  test("keeps running as a job, and nothing it printed is lost or shown twice", async () => {
    const { jobs, ctx } = rig();
    const first = await tool("Bash").run({ command: node("console.log('one'); setTimeout(() => { console.log('two'); }, 1800); setTimeout(() => {}, 2600)"), timeout: 1 }, ctx);
    expect(first).toContain("one");
    expect(first).not.toContain("two");
    expect(first).toContain('[still running after 1s as job1: BashOutput job_id "job1" shows what it prints next, KillShell stops it]');
    const next = await tool("BashOutput").run({ job_id: "job1", wait: 10 }, ctx);
    expect(next).toContain("two");
    expect(next).not.toContain("one");
    const end = await tool("BashOutput").run({ job_id: "job1", wait: 10 }, ctx);
    expect(end).toContain("[job1: done, exit 0]");
    jobs.close();
  });

  test("what was too long to show is saved to a file, and the job goes on from after it", async () => {
    const { jobs, ctx } = rig();
    const first = await tool("Bash").run({ command: node("process.stdout.write('x'.repeat(50000) + '\\nEND-OF-BULK\\n'); setTimeout(() => console.log('LATER'), 1500); setTimeout(() => {}, 2200)"), timeout: 1 }, ctx);
    const saved = /saved in (\S+):/.exec(first)?.[1];
    expect(saved).toBeDefined();
    expect(readFileSync(saved!, "utf8")).toContain("END-OF-BULK");
    expect(first).toContain("as job1");
    const next = await tool("BashOutput").run({ job_id: "job1", wait: 10 }, ctx);
    expect(next).toContain("LATER");
    expect(next).not.toContain("END-OF-BULK");
    rmSync(join(saved!, ".."), { recursive: true, force: true });
    jobs.close();
  });

  test.skipIf(!posix)("is stopped with everything it started when the program ends", async () => {
    const { jobs, ctx } = rig();
    await tool("Bash").run({ command: "sleep 47.31 & sleep 47.32", timeout: 1 }, ctx);
    const left = (): string => Bun.spawnSync(["pgrep", "-f", "sleep 47.3"]).stdout.toString().trim();
    expect(left()).not.toBe("");
    jobs.close();
    for (let i = 0; i < 40 && left() !== ""; i++) await Bun.sleep(100);
    expect(left()).toBe("");
  });

  test("a command that finishes in time is answered as before, with no job", async () => {
    const { jobs, ctx } = rig();
    expect(await tool("Bash").run({ command: "echo quick", timeout: 5 }, ctx)).toMatch(/quick[\s\S]*\[exit 0\]/);
    expect(jobs.list()).toEqual([]);
  });
});

describe("the folder of one command", () => {
  test("is where it runs, for that command only", async () => {
    const { ctx } = rig();
    mkdirSync(join(dir, "app"), { recursive: true });
    const inApp = await tool("Bash").run({ command: node("console.log(process.cwd())"), cwd: "app" }, ctx);
    expect(inApp.replaceAll("\\", "/")).toContain("/app");
    const after = await tool("Bash").run({ command: node("console.log(process.cwd())") }, ctx);
    expect(after.replaceAll("\\", "/")).not.toContain("/app\n");
    expect(after.replaceAll("\\", "/")).toContain(dir.replaceAll("\\", "/").split("/").pop()!);
  });
  test("a folder that is not there, or outside what the conversation may use, is a sentence", async () => {
    const { ctx } = rig();
    expect(await tool("Bash").run({ command: "echo x", cwd: "nowhere" }, ctx)).toMatch(/^Error: the folder .*nowhere does not exist\.$/);
    mkdirSync(join(dir, "app"), { recursive: true });
    const confined = rig({ cwd: join(dir, "app"), root: join(dir, "app") });
    expect(await tool("Bash").run({ command: "echo x", cwd: ".." }, confined.ctx)).toMatch(/^Error: that is outside the folder/);
    expect(await tool("Bash").run({ command: "echo x", cwd: "." }, confined.ctx)).not.toMatch(/^Error/);
  });
});

describe("a server that says where it listens", () => {
  test("the ports are read from what it printed, once each, and only while it runs", () => {
    expect(portsIn("ready on http://localhost:3000/ and http://127.0.0.1:3000\nlistening on port 5173\nbound 0.0.0.0:8080 [::1]:9000 *:7000")).toEqual([3000, 5173, 8080, 9000, 7000]);
    expect(portsIn("took 12:30 to build; at 10.0.0.1:99999")).toEqual([]);
    expect(portsIn("a:b".repeat(1000))).toEqual([]);
  });
  test("the state line of BashOutput names them, and a job that has ended names none", async () => {
    const { jobs, ctx } = rig();
    await tool("Bash").run({ command: node("console.log('serving on http://localhost:4321'); setTimeout(() => {}, 4000)"), run_in_background: true }, ctx);
    const out = await tool("BashOutput").run({ job_id: "job1", wait: 5, until: "serving" }, ctx);
    expect(out).toContain("[job1: still running, listening on 4321]");
    jobs.stopAll();
    await Bun.sleep(50);
    expect(await tool("BashOutput").run({ job_id: "job1" }, ctx)).not.toContain("listening on");
    jobs.close();
  });
});

describe("waiting for a sign that it is ready", () => {
  test("returns when the text has appeared, in any case, not at the first output", async () => {
    const { jobs, ctx } = rig();
    await tool("Bash").run({ command: node("console.log('starting'); setTimeout(() => console.log('Ready in 3 ms'), 800); setTimeout(() => {}, 3000)"), run_in_background: true }, ctx);
    const t0 = Date.now();
    const out = await tool("BashOutput").run({ job_id: "job1", wait: 10, until: "ready in" }, ctx);
    expect(out).toContain("starting");
    expect(out).toContain("Ready in 3 ms");
    expect(Date.now() - t0).toBeGreaterThan(600);
    jobs.close();
  });
  test("returns when the command ends, and gives up at the time asked", async () => {
    const { jobs, ctx } = rig();
    await tool("Bash").run({ command: node("console.log('bye')"), run_in_background: true }, ctx);
    const t0 = Date.now();
    expect(await tool("BashOutput").run({ job_id: "job1", wait: 10, until: "never printed" }, ctx)).toContain("[job1: done, exit 0]");
    expect(Date.now() - t0).toBeLessThan(3000);
    await tool("Bash").run({ command: node("setTimeout(() => {}, 4000)"), run_in_background: true }, ctx);
    const t1 = Date.now();
    expect(await tool("BashOutput").run({ job_id: "job2", wait: 1, until: "never printed" }, ctx)).toContain("(no new output)");
    expect(Date.now() - t1).toBeLessThan(2500);
    jobs.close();
  });
});

describe("the list of jobs", () => {
  test("BashOutput without an id lists them with their state, and says so when there are none", async () => {
    const { jobs, ctx } = rig();
    expect(await tool("BashOutput").run({}, ctx)).toBe("No command is running in the background.");
    await tool("Bash").run({ command: node("setTimeout(() => {}, 4000)"), run_in_background: true, description: "dev server" }, ctx);
    await tool("Bash").run({ command: node("console.log('x')"), run_in_background: true, description: "quick one" }, ctx);
    await Bun.sleep(600);
    expect((await tool("BashOutput").run({}, ctx)).split("\n")).toEqual(["job1 running 1 s: dev server", "job2 done, exit 0: quick one"]);
    jobs.close();
  });
});

describe.skipIf(!posix)("stopping a job", () => {
  test("a program that quits when asked is not killed: it gets to finish", async () => {
    const { jobs, ctx } = rig();
    const mark = join(dir, "clean-exit");
    await tool("Bash").run({ command: node(`process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(mark)}, 'saved'); process.exit(0); }); console.log('up'); setTimeout(() => {}, 30000)`), run_in_background: true }, ctx);
    await tool("BashOutput").run({ job_id: "job1", wait: 5, until: "up" }, ctx);
    expect(await tool("KillShell").run({ job_id: "job1" }, ctx)).toBe("job1 is stopping.");
    for (let i = 0; i < 40 && !existsSync(mark); i++) await Bun.sleep(100);
    expect(readFileSync(mark, "utf8")).toBe("saved");
    jobs.close();
  });

  test("one that ignores the request is forced after a few seconds, and the job is then reported stopped", async () => {
    const { jobs, ctx, events } = rig();
    await tool("Bash").run({ command: node("process.on('SIGTERM', () => {}); console.log('stubborn'); setTimeout(() => {}, 60000)"), run_in_background: true }, ctx);
    await tool("BashOutput").run({ job_id: "job1", wait: 5, until: "stubborn" }, ctx);
    const t0 = Date.now();
    await tool("KillShell").run({ job_id: "job1" }, ctx);
    for (let i = 0; i < 100 && !events.some((e) => e.ev === "job" && e.status === "stopped"); i++) await Bun.sleep(100);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThan(2500);
    expect(took).toBeLessThan(8000);
    jobs.close();
  });

  test("the person's Stop button and a stop by the program are immediate", async () => {
    const { jobs, ctx, events } = rig();
    await tool("Bash").run({ command: node("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"), run_in_background: true }, ctx);
    const t0 = Date.now();
    jobs.stop("job1");
    for (let i = 0; i < 60 && !events.some((e) => e.ev === "job" && e.status === "stopped"); i++) await Bun.sleep(50);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(events.some((e) => e.ev === "job" && e.status === "stopped")).toBe(true);
    jobs.close();
  });
});
