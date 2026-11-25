import { afterAll, describe, expect, test } from "bun:test";
import type { ModelRequest } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until, wait, type Step } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);
const node = (code: string): string => `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} -e ${JSON.stringify(code)}`;
const lastUser = (req: ModelRequest): string => { const m = [...req.messages].reverse().find((x) => x.role === "user"); return typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(""); };
const woken = (r: ReturnType<typeof rig>): string[] => r.of("user").map((u) => u.text).filter((t) => t.startsWith("[job"));

/** The model starts one background command on the first message and says nothing more until it is woken. */
const starts = (command: string, extra: Record<string, unknown> = {}) => (req: ModelRequest, n: number): Step => {
  if (req.messages.at(-1)?.role === "tool") return { text: "started" };
  return lastUser(req).startsWith("[job") ? { text: "saw it" } : n === 0 ? { calls: [{ name: "Bash", args: { command, run_in_background: true, ...extra } }] } : { text: "ok" };
};

describe("a command that ended wakes an idle conversation", () => {
  test("the model is told what finished, with the end of its output, without anybody typing", async () => {
    const r = rig(starts(node("setTimeout(() => console.log('build ok'), 300)")), { wake: true });
    await r.turn(prompt("build it", { mode: "auto" }));
    await until(() => r.of("done").length === 2);
    const [note] = woken(r);
    expect(note).toMatch(/^\[job1 finished: exit 0, \d\.\d s; BashOutput job1 for the rest\]\nbuild ok$/);
    expect(lastUser(r.provider.requests.at(-1)!)).toBe(note!);
    expect(r.text()).toContain("saw it");
    // The note was the news: the model is not told a second time in the request itself.
    expect(r.provider.requests.at(-1)!.system).not.toContain("[job1 finished");
    r.cleanup();
  }, 20_000);

  test("a host that did not ask for it gets the news with the next message, as before", async () => {
    const r = rig(starts(node("console.log('x')")));
    await r.turn(prompt("go", { mode: "auto" }));
    await wait(700);
    expect(r.of("done").length).toBe(1);
    expect(woken(r)).toEqual([]);
    await r.turn(prompt("and now?", { mode: "auto" }));
    expect(r.provider.requests.at(-1)!.system).toContain("[job1 finished");
    r.cleanup();
  }, 20_000);

  test("while a turn is running the news joins that turn and starts no other", async () => {
    let calls = 0;
    const r = rig((req, n) => {
      if (req.messages.at(-1)?.role === "tool") { calls++; return calls === 1 ? { calls: [{ name: "Bash", args: { command: "sleep 0.8" } }] } : { text: "all done" }; }
      return n === 0 ? { calls: [{ name: "Bash", args: { command: node("console.log('quick')"), run_in_background: true } }] } : { text: "ok" };
    }, { wake: true });
    await r.turn(prompt("go", { mode: "auto" }));
    await wait(500);
    expect(r.of("done").length).toBe(1);
    expect(woken(r)).toEqual([]);
    expect(r.provider.requests.at(-1)!.system).toContain("[job1 finished: exit 0");
    r.cleanup();
  }, 20_000);

  test("a job started with notify off does not wake it", async () => {
    const r = rig(starts(node("console.log('quiet')"), { notify: "off" }), { wake: true });
    const out = await r.turn(prompt("go", { mode: "auto" }));
    await wait(700);
    expect(woken(r)).toEqual([]);
    expect(r.of("done").length).toBe(1);
    expect(JSON.stringify(out)).toContain("It will not wake you");
    r.cleanup();
  }, 20_000);

  test("a turn that was cancelled is not followed by a wake: the news waits for the person", async () => {
    const r = rig((req, n) => (req.messages.at(-1)?.role === "tool" ? { text: "x", delayMs: 5000 } : n === 0 ? { calls: [{ name: "Bash", args: { command: node("console.log('quick')"), run_in_background: true } }] } : { text: "ok" }), { wake: true });
    r.send(prompt("go", { mode: "auto" }));
    await until(() => r.provider.requests.length >= 2);
    await wait(400);
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    await wait(300);
    expect(woken(r)).toEqual([]);
    await r.turn(prompt("again", { mode: "auto" }));
    expect(r.provider.requests.at(-1)!.system).toContain("[job1 finished: exit 0");
    r.cleanup();
  }, 20_000);

  test("two jobs that end together wake it twice, not within the gap", async () => {
    const r = rig((req, n) => {
      if (req.messages.at(-1)?.role === "tool") return { text: "started" };
      if (lastUser(req).startsWith("[job")) return { text: "saw it" };
      return n === 0 ? { calls: [{ name: "Bash", args: { command: node("setTimeout(() => console.log('a'), 200)"), run_in_background: true } }, { name: "Bash", args: { command: node("setTimeout(() => console.log('b'), 260)"), run_in_background: true } }] } : { text: "ok" };
    }, { wake: true, wakeGapMs: 700 });
    await r.turn(prompt("go", { mode: "auto" }));
    await until(() => woken(r).length === 1);
    await wait(250);
    expect(woken(r).length).toBe(1);
    await until(() => woken(r).length === 2);
    expect(woken(r).map((t) => /^\[(job\d)/.exec(t)![1])).toEqual(["job1", "job2"]);
    r.cleanup();
  }, 20_000);
});

describe("a line the model asked to be told about", () => {
  test("wakes it, at most three times, and the end of the job wakes it once more", async () => {
    const lines = "let n = 0; const t = setInterval(() => { console.log('ready ' + (++n)); if (n === 6) { clearInterval(t); } }, 120);";
    const r = rig(starts(node(lines), { notify: "ready" }), { wake: true, wakeGapMs: 0 });
    await r.turn(prompt("go", { mode: "auto" }));
    await until(() => woken(r).some((t) => t.includes("finished")), 10_000);
    const notes = woken(r);
    const printed = notes.filter((t) => t.startsWith("[job1 printed"));
    expect(printed.length).toBe(3);
    expect(printed[2]).toContain("it does not wake you again");
    expect(printed[0]).toMatch(/^\[job1 printed "ready \d"; BashOutput job1 for the rest\]/);
    expect(notes.filter((t) => t.includes("finished: exit 0")).length).toBe(1);
    r.cleanup();
  }, 30_000);

  test("what it matches is the line, whatever its case, and a line cut between two reads is still found", async () => {
    const r = rig(starts(node("process.stdout.write('Listen'); setTimeout(() => { process.stdout.write('ing on 8080\\n'); setTimeout(() => {}, 400); }, 250)"), { notify: "listening on" }), { wake: true, wakeGapMs: 0 });
    await r.turn(prompt("go", { mode: "auto" }));
    await until(() => woken(r).some((t) => t.startsWith("[job1 printed")));
    expect(woken(r)[0]).toContain('"Listening on 8080"');
    r.cleanup();
  }, 20_000);
});

describe("the person writing again", () => {
  test("a person's message is a prompt like any other and ends what was waiting for the gap", async () => {
    const r = rig(starts(node("setTimeout(() => console.log('late'), 400)")), { wake: true });
    await r.turn(prompt("go", { mode: "auto" }));
    await until(() => r.of("done").length === 2);
    await r.turn(prompt("thanks", { mode: "auto", qid: "q-thanks" }));
    expect(r.of("user").map((u) => u.text)).toContain("thanks");
    r.cleanup();
  }, 20_000);
});
