import { afterAll, describe, expect, test } from "bun:test";
import { CloudSchedule, Jobs, cronOfTiming, defaultTools, parseCron, parseWhen, type ScheduleBackend, type ScheduleInput, type ScheduleJob, type ScheduleRun, type ToolContext } from "../src/index.ts";
import { needsApproval, toolsFor } from "../src/permissions.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const T0 = Date.UTC(2026, 10, 25, 8, 0);
const tool = defaultTools().find((t) => t.name === "Schedule")!;

describe("what a person or a model writes for when", () => {
  const at = (ms: number) => ({ kind: "at", at: T0 + ms });
  const table: [string, unknown][] = [
    ["in 20 minutes", at(20 * 60_000)],
    ["in 2h", at(2 * 3_600_000)],
    ["in 1 day", at(86_400_000)],
    ["in 90 seconds", at(90_000)],
    ["every 2h", { kind: "every", ms: 7_200_000 }],
    ["every 30 minutes", { kind: "every", ms: 1_800_000 }],
    ["every hour", { kind: "every", ms: 3_600_000 }],
    ["every 60s", { kind: "every", ms: 60_000 }],
    ["hourly", { kind: "cron", cron: "0 * * * *" }],
    ["daily at 09:00", { kind: "cron", cron: "0 9 * * *" }],
    ["Daily at 9pm", { kind: "cron", cron: "0 21 * * *" }],
    ["every day at 7:30", { kind: "cron", cron: "30 7 * * *" }],
    ["weekdays at 9", { kind: "cron", cron: "0 9 * * 1-5" }],
    ["weekly on monday at 09:00", { kind: "cron", cron: "0 9 * * 1" }],
    ["every friday at 17:45", { kind: "cron", cron: "45 17 * * 5" }],
    ["sundays at 12am", { kind: "cron", cron: "0 0 * * 0" }],
    ["0 9 * * 1-5", { kind: "cron", cron: "0 9 * * 1-5" }],
    ["@daily", { kind: "cron", cron: "@daily" }],
    ["2026-12-01T09:00:00Z", { kind: "at", at: Date.UTC(2026, 11, 1, 9) }],
    ["2026-12-01 09:00+07:00", { kind: "at", at: Date.UTC(2026, 11, 1, 2) }],
  ];
  for (const [text, want] of table) test(`"${text}"`, () => expect(parseWhen(text, { now: T0 })).toEqual(want as never));

  test("a wall-clock time is in the named time zone, and a time that does not exist there is said so", () => {
    expect(parseWhen("2026-12-01 09:00", { now: T0, zone: "Asia/Jakarta" })).toEqual({ kind: "at", at: Date.UTC(2026, 11, 1, 2) });
    expect(parseWhen("2026-03-08 02:30", { now: T0 - 90 * 86_400_000, zone: "America/New_York" })).toContain("does not exist");
  });

  const refused: [string, string][] = [
    ["", "Say when as"],
    ["every 30s", "once every 60 seconds"],
    ["every second", "once every 60 seconds"],
    ["in 0 minutes", "not in the future"],
    ["in a while", "Say when as"],
    ["2026-11-25 07:00", "already passed"],
    ["2026-12-01", "time of day too"],
    ["2026-02-30 09:00", "not a real date"],
    ["daily", "Say the time of day"],
    ["daily at 25:00", "not a time of day"],
    ["weekly on funday at 9", "Say when as"],
    ["0 9 * *", "five parts"],
    ["61 * * * *", "outside 0 to 59"],
  ];
  for (const [text, why] of refused) test(`"${text}" is refused in a plain sentence`, () => {
    const got = parseWhen(text, { now: T0 });
    expect(typeof got).toBe("string");
    expect(got as string).toContain(why);
  });
});

/** A backend in memory with a clock a test moves by hand. */
class Memory implements ScheduleBackend {
  about = "It runs here.";
  maxJobs = 3;
  canChange = true;
  clock = T0;
  jobs: (ScheduleJob & { runs: ScheduleRun[] })[] = [];
  made = 0;
  now = () => this.clock;
  async list() { return this.jobs.map(({ runs: _r, ...j }) => j); }
  async create(i: ScheduleInput) {
    const j = { id: `j${++this.made}`, name: i.name, prompt: i.prompt, when: i.timing.kind === "cron" ? i.timing.cron : i.timing.kind === "every" ? `every ${i.timing.ms / 1000}s` : "once", ...(i.tz ? { tz: i.tz } : {}), mode: i.mode, enabled: true, next: i.timing.kind === "at" ? i.timing.at : this.clock + 60_000, runs: [] as ScheduleRun[] };
    this.jobs.push(j);
    return j;
  }
  async update(id: string, c: Partial<ScheduleInput>) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return "There is no such job";
    Object.assign(j, { ...(c.name ? { name: c.name } : {}), ...(c.prompt ? { prompt: c.prompt } : {}), ...(c.mode ? { mode: c.mode } : {}), ...(c.tz ? { tz: c.tz } : {}), ...(c.timing ? { when: JSON.stringify(c.timing) } : {}) });
    return j;
  }
  async setEnabled(id: string, enabled: boolean) { const j = this.jobs.find((x) => x.id === id)!; j.enabled = enabled; return j; }
  async remove(id: string) { this.jobs = this.jobs.filter((x) => x.id !== id); return true as const; }
  async runs(id: string) { return this.jobs.find((x) => x.id === id)?.runs ?? "There is no such job."; }
}

const ctx = (schedule?: ScheduleBackend, extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: ".", signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...(schedule ? { schedule } : {}), ...extra });
const call = (args: Record<string, unknown>, c: ToolContext) => tool.run(tool.fixArgs!(args), c);

describe("the Schedule tool on any backend", () => {
  test("it makes, lists, changes, pauses, resumes and removes a job; the answers say when it runs next", async () => {
    const m = new Memory();
    const c = ctx(m);
    const made = await call({ action: "create", name: "digest", prompt: "summarise the commits", when: "every 2h", mode: "plan", tz: "Asia/Jakarta" }, c);
    expect(made).toContain('j1 "digest"');
    expect(made).toContain("next 2026-11-25 15:01 Asia/Jakarta");
    expect(made).toContain("It runs here.");
    expect(await call({ action: "list" }, c)).toContain("mode plan");
    expect(await call({ action: "update", id: "digest", when: "daily at 09:00", prompt: "write the digest" }, c)).toContain("Changed j1");
    expect(m.jobs[0]!.prompt).toBe("write the digest");
    expect(await call({ action: "pause", id: "j1" }, c)).toContain("paused");
    expect(await call({ action: "resume", id: "j1" }, c)).not.toContain("paused");
    expect(await call({ action: "remove", id: "j1" }, c)).toBe('Removed j1 "digest".');
    expect(await call({ action: "list" }, c)).toBe("There are no jobs yet.");
  });

  test("a missed run says it was missed, with the time it was due, and the last outcome is on the list", async () => {
    const m = new Memory();
    const c = ctx(m);
    await call({ prompt: "check", when: "daily at 09:00", tz: "UTC" }, c);
    m.jobs[0]!.runs = [{ at: Date.UTC(2026, 10, 25, 10, 5), outcome: "ok", due: Date.UTC(2026, 10, 25, 9, 0) }, { at: Date.UTC(2026, 10, 24, 9, 0), outcome: "failed", note: "exit 1" }];
    Object.assign(m.jobs[0]!, { lastOutcome: "ok", lastAt: Date.UTC(2026, 10, 25, 10, 5) });
    const runs = await call({ action: "runs", id: "j1" }, c);
    expect(runs).toBe("2026-11-25 10:05 UTC ok (missed: it was due 2026-11-25 09:00 UTC and started late)\n2026-11-24 09:00 UTC failed: exit 1");
    expect(await call({ action: "list" }, c)).toContain("last ok 2026-11-25 10:05 UTC");
    expect(await call({ action: "runs", id: "nobody" }, c)).toContain('There is no job "nobody"');
  });

  test("the limits are plain sentences: prompt length, name length, number of jobs, interval, time zone, mode", async () => {
    const m = new Memory();
    const c = ctx(m);
    const make = (o: Record<string, unknown>) => call({ action: "create", prompt: "p", when: "daily at 09:00", ...o }, c);
    expect(await make({ prompt: "x".repeat(4001) })).toBe("Error: The prompt may be at most 4000 characters.");
    expect(await make({ name: "n".repeat(81) })).toContain("name may be at most 80");
    expect(await make({ prompt: "  " })).toContain("needs a prompt");
    expect(await make({ when: "every 10s" })).toContain("once every 60 seconds");
    expect(await make({ when: "" })).toContain("say when");
    expect(await make({ tz: "Mars/Base" })).toContain("not a time zone");
    expect(await make({ mode: "root" })).toContain('mode is "plan"');
    expect(m.jobs.length).toBe(0);
    for (let i = 0; i < 3; i++) await make({ name: `job ${i}` });
    expect(await make({})).toBe("Error: At most 3 jobs are kept. Remove one first.");
  });

  test("a job that is running may look but never change; without a backend there is nothing to do", async () => {
    const m = new Memory();
    m.canChange = false;
    const c = ctx(m);
    expect(await call({ action: "list" }, c)).toBe("There are no jobs yet.");
    for (const a of ["create", "update", "pause", "resume", "remove"]) expect(await call({ action: a, id: "j1", prompt: "p", when: "daily at 09:00" }, c)).toContain("cannot change the jobs");
    expect(await call({ action: "list" }, ctx())).toContain("cannot be scheduled here");
  });

  test("a model that has read the web cannot make a job that may change things", async () => {
    const m = new Memory();
    const made = await call({ action: "create", prompt: "p", when: "daily at 09:00", mode: "auto" }, ctx(m, { untrusted: true }));
    expect(made).toContain("needs the person's own request");
    expect(m.jobs.length).toBe(0);
    expect(await call({ action: "create", prompt: "p", when: "daily at 09:00", mode: "auto" }, ctx(m))).toContain("mode auto");
  });

  test("a job is found by id, by name or by the start of its id; an unknown one lists the jobs", async () => {
    const m = new Memory();
    const c = ctx(m);
    await call({ prompt: "one", name: "Morning", when: "daily at 09:00" }, c);
    expect(await call({ action: "pause", id: "morning" }, c)).toContain("j1");
    expect(await call({ action: "pause", id: "j" }, c)).toContain("j1");
    expect(await call({ action: "pause", id: "zzz" }, c)).toBe('Error: There is no job "zzz". The jobs are: j1 "Morning".');
  });

  test("models that write the fields in other words, or leave the action out, are understood", async () => {
    const m = new Memory();
    const c = ctx(m);
    expect(await call({ prompt: "x", schedule: "daily at 09:00", timezone: "UTC" }, c)).toContain("Created j1");
    expect(m.jobs[0]!.tz).toBe("UTC");
    expect(await call({}, c)).toContain("j1");
  });
});

describe("when the tool is offered", () => {
  const all = defaultTools();
  const names = (userText: string, o: { small?: boolean; schedule?: boolean } = {}) => toolsFor("auto", all, { small: o.small ?? false, userText, jobs: 0, schedule: o.schedule ?? true }).map((t) => t.name);
  test("a large model gets it when the request is about timing, and not otherwise", () => {
    for (const text of ["run the tests every night", "remind me tomorrow to deploy", "schedule a backup", "check the build in 20 minutes", "do it daily at 9am", "set up a cron for this"]) expect(names(text), text).toContain("Schedule");
    for (const text of ["fix the failing test in a.ts", "rename the function", "what does this regex do"]) expect(names(text), text).not.toContain("Schedule");
  });
  test("a small model is not shown it, and nor is a place that cannot schedule", () => {
    expect(names("run the tests every night", { small: true })).not.toContain("Schedule");
    expect(names("run the tests every night", { schedule: false })).not.toContain("Schedule");
  });
  test("looking is never asked about; every change is, and plan mode does not offer it", () => {
    for (const action of ["list", "runs"]) expect(needsApproval("ask", tool, { action })).toBe(false);
    for (const action of ["create", "update", "pause", "resume", "remove"]) expect(needsApproval("ask", tool, { action })).toBe(true);
    expect(needsApproval("edits", tool, { action: "create" })).toBe(true);
    expect(toolsFor("plan", all, { small: false, userText: "run it every night", jobs: 0, schedule: true }).map((t) => t.name)).not.toContain("Schedule");
  });
  test("its text is small", () => {
    expect(JSON.stringify({ description: tool.description, parameters: tool.parameters }).length).toBeLessThanOrEqual(700);
  });
});

describe("in a conversation", () => {
  const script = (args: object) => (req: { messages: { role: string }[] }) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Schedule", args }] });

  test("a small model is told its name; a call is run; a mode that may change things is asked of the person first, and the plan one asked too", async () => {
    const m = new Memory();
    const r = rig(script({ action: "create", prompt: "tidy the logs", when: "every 2h", mode: "auto" }), { schedule: m, window: 4_000 });
    r.send(prompt("keep the logs tidy", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    expect(r.provider.requests[0]!.system).toContain("Schedule");
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Schedule");
    expect(r.of("approval")[0]!.title).toContain("allowed to change things");
    expect(m.jobs.length).toBe(0);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow" });
    await r.engine.idle();
    expect(m.jobs.map((j) => j.mode)).toEqual(["auto"]);
    r.cleanup();
  });

  test("a list is not asked about; the row switch off refuses it by name", async () => {
    const m = new Memory();
    const r = rig(script({ action: "list" }), { schedule: m });
    await r.turn(prompt("what is scheduled every day?", { mode: "ask" }));
    expect(r.of("approval").length).toBe(0);
    expect(r.provider.requests[0]!.tools.map((t) => t.name)).toContain("Schedule");
    r.cleanup();
    const off = rig(script({ action: "list" }), { schedule: m, toolOn: (n) => n !== "Schedule" });
    await off.turn(prompt("what is scheduled every day?", { mode: "ask" }));
    expect(off.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Schedule");
    expect(off.provider.requests[0]!.system).not.toContain("Schedule");
    expect(off.events.some((e) => e.ev === "tool" && e.status === "error" && String(e.output).includes("turned off by the person"))).toBe(true);
    off.cleanup();
  });

  test("without a backend the tool is not even named", async () => {
    const r = rig(() => ({ text: "x" }));
    await r.turn(prompt("run it every day"));
    expect(r.provider.requests[0]!.system).not.toContain("Schedule");
    r.cleanup();
  });
});

describe("cloud jobs over /v1/schedule", () => {
  interface Seen { auth: string | null; body: Record<string, unknown> }
  /** A localhost stand-in for the contract in the hosted document: the same actions, bodies and answers. */
  function fake(handler: (body: Record<string, unknown>, seen: Seen[]) => Response) {
    const seen: Seen[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/schedule" || req.method !== "POST") return new Response("no", { status: 404 });
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ auth: req.headers.get("authorization"), body });
      return handler(body, seen);
    } });
    return { seen, url: `http://127.0.0.1:${server.port}/v1/web`, stop: () => server.stop(true) };
  }
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const cloudJob = { id: "a1b2", name: "digest", prompt: "p", cron: "0 */2 * * *", tz: "UTC", mode: "plan", enabled: true, next: T0 + 3_600_000, lastOutcome: "missed", lastAt: T0 - 3_600_000, runs: [{ id: "r1", at: T0 - 3_600_000, outcome: "missed", note: "no place was free" }] };

  test("each action is one POST on the session's grant, in the shape of the contract, and the answers are shown", async () => {
    const f = fake((b) => (b.action === "list" ? json({ jobs: [cloudJob] }) : b.action === "remove" ? json({ removed: b.id }) : json({ job: cloudJob })));
    const cloud = new CloudSchedule({ url: f.url, token: "grant-123" }, () => T0);
    const c = ctx(cloud);
    expect(await call({ action: "list" }, c)).toBe('a1b2 "digest": 0 */2 * * * UTC, mode plan, next 2026-11-25 09:00 UTC, last missed 2026-11-25 07:00 UTC');
    expect(await call({ action: "runs", id: "a1b2" }, c)).toBe("2026-11-25 07:00 UTC missed: no place was free");
    await call({ action: "create", name: "digest", prompt: "p", when: "every 2h", tz: "Asia/Jakarta" }, c);
    await call({ action: "update", id: "a1b2", when: "weekdays at 9", mode: "auto" }, c);
    await call({ action: "pause", id: "a1b2" }, c);
    await call({ action: "resume", id: "a1b2" }, c);
    expect(await call({ action: "remove", id: "a1b2" }, c)).toContain("Removed a1b2");
    expect(f.seen.every((s) => s.auth === "Bearer grant-123")).toBe(true);
    const bodies = f.seen.map((s) => s.body).filter((b) => b.action !== "list");
    expect(bodies).toEqual([
      { action: "create", name: "digest", prompt: "p", cron: "0 */2 * * *", tz: "Asia/Jakarta", mode: "plan" },
      { action: "update", id: "a1b2", cron: "0 9 * * 1-5", mode: "auto" },
      { action: "pause", id: "a1b2" },
      { action: "resume", id: "a1b2" },
      { action: "remove", id: "a1b2" },
    ]);
    f.stop();
  });

  test("the server's own refusals reach the model as they are said", async () => {
    const said = ["Not allowed: cloud jobs are off.", "Not allowed: cloud jobs need an account. Sign in first.", "A cloud job may run at most once every 60 minutes.", "An account may keep 20 cloud jobs. Remove one first."];
    for (const message of said) {
      const f = fake((b) => (b.action === "list" ? json({ jobs: [] }) : json({ error: { message, type: "forbidden" } }, 403)));
      const got = await call({ action: "create", prompt: "p", when: "daily at 09:00" }, ctx(new CloudSchedule({ url: f.url, token: "t" })));
      expect(got).toBe(`Error: ${message}`);
      f.stop();
    }
    const down = await call({ action: "list" }, ctx(new CloudSchedule({ url: "http://127.0.0.1:9/v1/web", token: "t" })));
    expect(down).toContain("could not be reached");
  });

  test("what a cloud job cannot do is said before anything is sent", async () => {
    const f = fake(() => json({ jobs: [] }));
    const c = ctx(new CloudSchedule({ url: f.url, token: "t" }));
    expect(await call({ action: "create", prompt: "p", when: "in 20 minutes" }, c)).toContain("one that runs once is not available");
    expect(await call({ action: "create", prompt: "p", when: "every 5h" }, c)).toContain("interval cannot be kept");
    expect(f.seen.filter((s) => s.body.action !== "list")).toEqual([]);
    f.stop();
  });

  test("an interval that fits the clock becomes a cron the server understands", () => {
    for (const [ms, cron] of [[1_800_000, "*/30 * * * *"], [3_600_000, "0 */1 * * *"], [7_200_000, "0 */2 * * *"], [43_200_000, "0 */12 * * *"], [86_400_000, "0 0 * * *"]] as const) {
      const got = cronOfTiming({ kind: "every", ms });
      expect(got).toEqual({ cron });
      expect(typeof parseCron(cron)).toBe("object");
    }
  });
});
