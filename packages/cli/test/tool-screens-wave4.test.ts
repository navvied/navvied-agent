import { describe, expect, test } from "bun:test";
import type { ComputerState, EngineEvent, ScheduleInfo, ScheduleRunInfo, ToolEntry } from "@navvied/protocol";
import { askApproval, screenRequest } from "../src/approval-ui.ts";
import { computerScreen } from "../src/computer-screen.ts";
import { pictureFile } from "../src/saved-files.ts";
import { scheduleScreen } from "../src/schedule-screen.ts";
import { toolSetup } from "../src/tool-setup.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

type Setup = Extract<EngineEvent, { ev: "tool.setup" }>;
const NOW = new Date(2026, 10, 25, 12, 0).getTime();
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, 25 + d, h, m).getTime();

describe("a task's earlier runs", () => {
  const job = (over: Partial<ScheduleInfo> = {}): ScheduleInfo => ({ id: "a", title: "Morning summary", prompt: "p", cron: "0 9 * * 1-5", when: { kind: "cron", cron: "0 9 * * 1-5" }, next: at(1, 9), last: at(0, 9), lastCode: 0, enabled: true, kind: "agent", mode: "plan", ...over });
  const hub = (jobs: ScheduleInfo[], runs: ScheduleRunInfo[]) => new FakeLink((c) => (c.cmd === "schedule.runs" ? { ev: "schedule.runs", id: "a", runs } : { ev: "schedules", items: jobs }));
  test("the list says a missed run in the page's words", async () => {
    const t = scripted([undefined]);
    await scheduleScreen(t.kit(hub([job({ missed: { at: at(-1, 9), reason: "off" } })], [])), () => NOW);
    expect(t.shown[0]!.items[0]!.hint).toContain("Missed yesterday 9:00. The computer was off.");
  });
  test("what it said before lists the last three runs, and a failed one opens to say why with Run now", async () => {
    const runs: ScheduleRunInfo[] = [{ at: at(0, 9), outcome: "fine", said: "Three commits yesterday." }, { at: at(-1, 9), outcome: "fine", said: "No commits yesterday." }, { at: at(-2, 9), outcome: "failed", said: "The folder could not be opened." }];
    const l = hub([job()], runs);
    const t = scripted([0, "What it said before", 2, "Run now", undefined]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.runs")).toEqual([{ cmd: "schedule.runs", id: "a", limit: 3 }]);
    const list = t.shown.find((s) => s.title === "What it said before")!;
    expect(list.items.map((i) => i.label)).toEqual(["✓  today 9:00  Fine", "✓  yesterday 9:00  Fine", "✗  Monday 9:00  Failed"]);
    expect(list.items[0]!.hint).toBe("Three commits yesterday.");
    expect(list.frame.body).toContain("The last three runs.");
    const detail = t.shown.find((s) => s.title === "Morning summary" && s.frame.body?.includes("The last run failed."))!;
    expect(detail.frame.body!.join("\n")).toContain("The folder could not be opened.");
    expect(l.commands("schedule.run")).toHaveLength(1);
  });
  test("no runs yet says so, and nothing more", async () => {
    const t = scripted([0, "What it said before", undefined, undefined]);
    await scheduleScreen(t.kit(hub([job()], [])), () => NOW);
    expect(t.shown.find((s) => s.title === "What it said before")!.frame.body).toEqual(["No runs yet."]);
  });
});

describe("the consent to use an application", () => {
  const ask = (about: "capture" | "input" | "foreground") => ({ ev: "approval" as const, id: "x", title: "Use Notes", screen: { app: "Notes", about, lines: ["click 12"] }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
  test("each question and each answer is in the page's words", () => {
    expect(screenRequest(ask("input").screen)).toEqual({ title: "Let navvied type and click in Notes?", body: "It will use the keyboard and the mouse in Notes only.", labels: { once: "Allow for this task", always: "Always allow Notes", no: "Do not allow" } });
    expect(screenRequest(ask("foreground").screen).title).toBe("Let navvied bring Notes to the front?");
    expect(screenRequest(ask("foreground").screen).labels).toEqual({ once: "Allow once", no: "Do not allow" });
  });
  test("the person's press gives back the option of the engine", async () => {
    const t = scripted([1, 2]);
    expect((await askApproval(t.io, ask("input"), undefined, "/w", 80)).optionId).toBe("always");
    expect((await askApproval(t.io, ask("input"), undefined, "/w", 80)).optionId).toBe("deny");
    expect(t.shown[0]!.title).toBe("Let navvied type and click in Notes?");
    expect(t.shown[0]!.items.map((i) => i.label)).toEqual(["Allow for this task", "Always allow Notes", "Do not allow"]);
  });
  test("a picture says its size in pixels", () => {
    expect(pictureFile({ path: "/w/p.png", bytes: 1_468_006, width: 1024, height: 1024, mime: "image/png" })).toEqual({ path: "/w/p.png", size: "1024 × 1024, 1.4 MB" });
  });
});

describe("setting a tool up", () => {
  const entry = { id: "browser", title: "Browser Automation", about: "Drive a real browser." } as ToolEntry;
  const steps = (states: ("waiting" | "active" | "done" | "failed")[]) => ["Download the browser (about 150 MB)", "Check the download", "Start it once to test"].map((name, i) => ({ name, state: states[i]!, bytes: 0, total: 0 }));
  const event = (state: Setup["state"], over: Partial<Setup> = {}): EngineEvent => ({ ev: "tool.setup", id: "browser", state, ...over });
  class Hub extends FakeLink {
    constructor(private script: Record<string, EngineEvent[]>) { super(() => undefined); }
    override send(cmd: object): void {
      super.send(cmd);
      const name = (cmd as { cmd: string }).cmd;
      for (const e of this.script[name] ?? []) queueMicrotask(() => this.emit(e));
    }
  }
  test("an answer that comes while the command is being sent is not missed, as with the engine inside this program", async () => {
    class SameProgram extends FakeLink {
      override send(cmd: object): void {
        super.send(cmd);
        const name = (cmd as { cmd: string }).cmd;
        if (name === "tool.setup") this.emit(event("ask", { steps: steps(["waiting", "waiting", "waiting"]) }));
        if (name === "tool.setup.approve") this.emit(event("done", { steps: steps(["done", "done", "done"]), percent: 100 }));
      }
    }
    const l = new SameProgram(() => undefined);
    const t = scripted(["Start setup"]);
    const kit = t.kit(l);
    await toolSetup(kit, entry);
    expect(l.commands("tool.setup.approve")).toHaveLength(1);
    expect(kit.note).toEqual(["Browser Automation is ready."]);
  });
  test("it says what it will do, starts on a press, shows the steps, and says when it is ready", async () => {
    const l = new Hub({
      "tool.setup": [event("ask", { steps: steps(["waiting", "waiting", "waiting"]) })],
      "tool.setup.approve": [event("downloading", { steps: steps(["active", "waiting", "waiting"]), percent: 20 })],
    });
    const t = scripted(["Start setup", { label: undefined, before: () => l.emit(event("done", { steps: steps(["done", "done", "done"]), percent: 100 })) }]);
    await toolSetup(t.kit(l), entry);
    const ask = t.shown[0]!;
    expect(ask.title).toBe("Needs setup");
    expect(ask.frame.body!.join("\n")).toContain("1  Download the browser (about 150 MB)");
    expect(l.commands("tool.setup.approve")).toEqual([{ cmd: "tool.setup.approve", id: "browser" }]);
    expect(t.shown[1]!.frame.body).toEqual(["✓  Download the browser (about 150 MB)", "✓  Check the download", "✓  Start it once to test"]);
    expect(t.shown[0]!.items.map((i) => i.label)).toEqual(["Start setup", "Not now"]);
    expect(t.shown.at(-1)).toBeDefined();
  });
  test("a step that has not started is marked with the small dot of the page", async () => {
    const l = new Hub({ "tool.setup": [event("failed", { steps: steps(["done", "failed", "waiting"]), error: "x" })] });
    const t = scripted(["Not now"]);
    await toolSetup(t.kit(l), entry);
    expect(t.shown[0]!.frame.body![2]).toBe("•  Start it once to test");
  });
  test("Not now stops it and keeps what was fetched", async () => {
    const l = new Hub({ "tool.setup": [event("ask", { steps: steps(["waiting", "waiting", "waiting"]) })] });
    const t = scripted(["Not now"]);
    await toolSetup(t.kit(l), entry);
    expect(l.commands("tool.setup.cancel")).toHaveLength(1);
  });
  test("a failed setup says why and offers to try again", async () => {
    const l = new Hub({ "tool.setup": [event("failed", { steps: steps(["done", "failed", "waiting"]), error: "The download stopped. Check the connection and try again." })] });
    const t = scripted(["Try again", "Not now"]);
    await toolSetup(t.kit(l), entry);
    const failed = t.shown[0]!;
    expect(failed.frame.body!.join("\n")).toContain("✗ The download stopped. Check the connection and try again.");
    expect(failed.frame.body![1]).toBe("✗  Check the download");
    expect(l.commands("tool.setup")).toHaveLength(2);
  });
  test("a tool that cannot be set up here says why", async () => {
    const l = new Hub({ "tool.setup": [event("unavailable", { error: "No browser was found on this computer." })] });
    const t = scripted([]);
    const k = t.kit(l);
    await toolSetup(k, entry);
    expect(k.note).toEqual(["No browser was found on this computer."]);
  });
});

describe("turning Computer Use on", () => {
  const hub = (states: ComputerState[]) => {
    let at = 0;
    return new FakeLink((c) => {
      if (c.cmd === "computer.on") return { ...states.at(-1)!, ...(states.at(-1)!.step === "ready" ? { on: c.on as boolean } : {}), ev: "computer.state" } as EngineEvent;
      const s = states[Math.min(at++, states.length - 1)]!;
      return { ev: "computer.state", ...s };
    });
  };
  const perm = (a: "granted" | "missing", s: "granted" | "missing") => [{ id: "accessibility" as const, state: a }, { id: "screen-recording" as const, state: s }];
  test("it says what it is, asks for the two permissions one at a time, then turns on", async () => {
    const l = hub([
      { on: false, step: "permissions", permissions: perm("granted", "missing") },
      { on: false, step: "permissions", permissions: perm("granted", "missing") },
      { on: false, step: "ready", permissions: perm("granted", "granted") },
    ]);
    const t = scripted(["Turn on", 1, "I did it", "Turn on"]);
    const k = t.kit(l);
    await computerScreen(k, { title: "Computer Use" });
    expect(t.shown[0]!.frame.body!.join("\n")).toContain("It asks before it uses an app, and you can stop it at any time.");
    const perms = t.shown.find((s) => s.title === "Two permissions")!;
    expect(perms.frame.body).toEqual(["Only you can answer the system's questions."]);
    expect(perms.items.map((i) => `${i.label}|${i.hint}`)).toEqual(["Accessibility  Granted|undefined", "Screen Recording  Allow|undefined"]);
    expect(l.commands("computer.permission")).toEqual([{ cmd: "computer.permission", id: "screen-recording" }]);
    expect(t.shown.find((s) => s.title === "Screen Recording")!.frame.body![1]).toBe("Switch navvied on there, then come back. navvied waits.");
    expect(l.commands("computer.on")).toEqual([{ cmd: "computer.on", on: true }]);
    expect(k.note).toEqual(["Computer Use is on. It asks before it uses an app."]);
  });
  test("where it cannot be used, the reason is said and nothing is asked", async () => {
    const t = scripted([]);
    const k = t.kit(hub([{ on: false, step: "unavailable", permissions: [], reason: "Open a conversation on your computer to use it." }]));
    await computerScreen(k, { title: "Computer Use" });
    expect(k.note).toEqual(["Open a conversation on your computer to use it."]);
    expect(t.shown).toHaveLength(0);
  });
  test("turning it off is one press", async () => {
    const l = hub([{ on: true, step: "ready", permissions: [] }]);
    const t = scripted([]);
    await computerScreen(t.kit(l), { title: "Computer Use" });
    expect(l.commands("computer.on")).toEqual([{ cmd: "computer.on", on: false }]);
  });
});
