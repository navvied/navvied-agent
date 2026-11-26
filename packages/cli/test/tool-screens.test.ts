import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EngineEvent, ScheduleInfo, ScheduleWhen } from "@navvied/protocol";
import { openScreen } from "../src/open-screen.ts";
import { Presenter } from "../src/presenter.ts";
import { Renderer } from "../src/render.ts";
import { savedFile } from "../src/saved-files.ts";
import { scheduleScreen } from "../src/schedule-screen.ts";
import { cronWords, scheduleOf, firstWhen, whenOf, whenWords } from "@navvied/protocol";
import { refusalWords } from "../src/screen-words.ts";
import { describeFailure, describeStep } from "../src/steps.ts";
import { resolveTheme, setTheme } from "../src/theme.ts";
import { fakeIO } from "./helpers.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

beforeAll(() => setTheme(resolveTheme({ theme: "dark" }, { COLORTERM: "truecolor" })));
afterAll(() => setTheme(resolveTheme(null, {})));

describe("steps of the new tools, in the words of the page", () => {
  test("media, browser and screen steps say what they did", () => {
    const say = (n: string, i: object, app = ""): string => describeStep(n, i, "/w", app).done;
    expect(say("MakeImage", { prompt: "x" })).toBe("Made a picture");
    expect(say("MakeVideo", {})).toBe("Made a short video");
    expect(say("Speak", {})).toBe("Read the text aloud");
    expect(say("Transcribe", {})).toBe("Turned speech into text");
    expect(say("LookAt", {})).toBe("Looked at the picture");
    expect(say("Browser", { action: "open", url: "https://example.com/pricing?x=1" })).toBe("Opened example.com/pricing");
    expect(say("Browser", { action: "screenshot" })).toBe("Took a screenshot");
    expect(say("Browser", { action: "dialog" })).toBe("Answered a dialog");
    expect(say("Computer", { action: "capture", app: "Notes" })).toBe("Looked at the screen");
    expect(say("Computer", { action: "type", text: "milk" }, "Notes")).toBe("Typed in Notes");
    expect(say("Computer", { action: "click" })).toBe("Clicked");
  });
  test("a step that failed says so in the same words", () => {
    expect(describeFailure("MakeImage", {}, "/w")).toBe("Could not make the picture");
    expect(describeFailure("Browser", { action: "screenshot" }, "/w")).toBe("Could not take a screenshot");
    expect(describeFailure("Browser", { action: "open", url: "http://192.168.1.1/" }, "/w")).toBe("Could not open 192.168.1.1");
  });
});

describe("a refusal on the screen", () => {
  const words = (code: string, extra: object = {}) => refusalWords({ verdict: "refused", code, ...extra });
  test("each closed reason has its own plain sentence", () => {
    expect(words("human_has_control", { app: "Notes" })).toEqual({ title: "Could not click in Notes", said: "You are using the screen. navvied waits." });
    expect(words("background_occluded", { app: "Notes" })!.said).toBe("Another window covers Notes. Move it, or let navvied bring Notes to the front.");
    expect(words("background_unavailable", { app: "Notes" })!.title).toBe("Could not work in Notes");
    expect(words("background_uipi_blocked", { app: "Task Manager" })!.said).toBe("This program needs higher rights, so navvied cannot control it.");
    expect(words("input_target_mismatch")!.title).toBe("Stopped before typing");
    expect(words("permission_missing", { which: "screen_recording" })!.title).toBe("Could not see the screen");
    expect(words("permission_missing", { which: "accessibility", app: "Notes" })!.said).toBe("Allow Accessibility for navvied in the system settings.");
    expect(words("blocked_by_policy", { app: "Passwords" })!.title).toBe("Could not open Passwords");
  });
  test("an app that matches no open window: the web's row title for the action and one sentence, never the sentence about a changed window", () => {
    const missing = (action: string, code: string) => refusalWords({ verdict: "refused", code, reason: "no_window", app: "Door" }, action)!;
    for (const [action, title] of [["capture", "Could not look at Door"], ["click", "Could not click in Door"], ["type", "Could not type in Door"], ["key", "Could not press keys in Door"], ["scroll", "Could not scroll Door"], ["list", "Could not list the apps"], ["wait", "Could not wait"]] as const) {
      for (const code of ["input_target_mismatch", "background_unavailable"]) expect(missing(action, code)).toEqual({ title, said: "No open window matches Door. Open it, then ask again." });
    }
  });
  test("the terminal's row for it reads the same, with the action taken from the step", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "read Door" }, { ev: "tool", id: "t", name: "computer", status: "running", input: { action: "capture", app: "Door" } },
      { ev: "tool", id: "t", name: "computer", status: "done", output: "refused: input_target_mismatch", screen: { verdict: "refused", code: "input_target_mismatch", reason: "no_window", app: "Door" } });
    expect(r.shown()).toContain("Could not look at Door");
    expect(r.shown()).toContain("No open window matches Door. Open it, then ask again.");
    expect(r.shown()).not.toContain("The window in front changed");
  });
  test("a step that was delivered, or a reason without words, has none", () => {
    expect(refusalWords({ verdict: "delivered" })).toBeUndefined();
    expect(words("stale_target")).toBeUndefined();
  });
});

describe("the files a step saved", () => {
  test("a media tool and a download both say where the file is and how big", () => {
    expect(savedFile("Saved /home/a/picture.png (1.4 MB).")).toEqual({ path: "/home/a/picture.png", size: "1.4 MB" });
    expect(savedFile("Saved /home/a/speech.wav (640 KB), 42 seconds.")).toEqual({ path: "/home/a/speech.wav", size: "640 KB" });
    expect(savedFile("Clicked.\nDownloaded downloads/report.pdf (86016 bytes).")).toEqual({ path: "downloads/report.pdf", size: "84 KB" });
    expect(savedFile("nothing here")).toBeUndefined();
  });
});

function rig() {
  const f = fakeIO({ color: false, interactive: true });
  const lives: string[][] = [];
  const io = { ...f.io, live: (lines: readonly string[]) => { lives.push([...lines]); } };
  const presenter = new Presenter(io, new Renderer(io, { thinking: false }), { cwd: () => "/w", thinking: false, width: () => 70, now: () => 0, every: () => () => undefined });
  const send = (...events: EngineEvent[]): void => { for (const e of events) presenter.handle(e); };
  return { presenter, send, shown: () => f.err() };
}

describe("in a conversation", () => {
  test("a saved picture stays on the screen with its path and size, and /open can list it", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "draw" }, { ev: "tool", id: "t", name: "MakeImage", status: "running", input: { prompt: "a lighthouse" } },
      { ev: "tool", id: "t", name: "MakeImage", status: "done", output: "Saved /w/picture.png (1.4 MB).", ms: 6100 });
    expect(r.shown()).toContain("Made a picture");
    expect(r.shown()).toContain("/w/picture.png");
    expect(r.shown()).toContain("1.4 MB");
    expect(r.presenter.files.list()).toEqual([{ path: "/w/picture.png", size: "1.4 MB" }]);
  });
  test("a refused screen step says why in plain words, not the engine's line", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "tool", id: "t", name: "Computer", status: "running", input: { action: "click", app: "Notes", target: 3 } },
      { ev: "tool", id: "t", name: "Computer", status: "done", output: "refused: human_has_control\nWait.", screen: { verdict: "refused", code: "human_has_control", app: "Notes" } });
    expect(r.shown()).toContain("Could not click in Notes");
    expect(r.shown()).toContain("You are using the screen. navvied waits.");
    expect(r.shown()).not.toContain("human_has_control");
  });
  test("while a screen step runs, the app it uses is known, and after it ends it is not", () => {
    const r = rig();
    r.send({ ev: "user", qid: "q", text: "x" }, { ev: "tool", id: "t", name: "Computer", status: "running", input: { action: "capture", app: "Notes" } });
    expect(r.presenter.usingApp).toBe("Notes");
    r.send({ ev: "tool", id: "t", name: "Computer", status: "done", output: "ok" });
    expect(r.presenter.usingApp).toBeUndefined();
  });
});

describe("/open", () => {
  test("opens the file picked, or its folder", async () => {
    const opened: string[] = [];
    const t = scripted([0, "Open", 0, "Show the folder"]);
    (t.io as { system: unknown }).system = { open: (p: string) => opened.push(p) };
    const files = [{ path: "/w/media/picture.png", size: "1.4 MB" }];
    await openScreen(t.io, files, t.said.push.bind(t.said));
    await openScreen(t.io, files, t.said.push.bind(t.said));
    expect(opened).toEqual(["/w/media/picture.png", "/w/media"]);
    expect(t.shown[0]!.items[0]).toMatchObject({ label: "picture.png", hint: "/w/media/picture.png, 1.4 MB" });
  });
  test("says so when nothing was made", async () => {
    const t = scripted([]);
    await openScreen(t.io, [], (s) => t.said.push(s));
    expect(t.said).toEqual(["Nothing has been made in this conversation yet."]);
  });
});

describe("/schedule", () => {
  const NOW = new Date(2026, 10, 25, 12, 0).getTime();
  const at = (d: number, h: number, m = 0): number => new Date(2026, 10, 25 + d, h, m).getTime();
  const job = (over: Partial<ScheduleInfo> = {}): ScheduleInfo => ({ id: "a", title: "Morning summary", prompt: "Summarise the new commits.", cron: "0 9 * * 1-5", when: { kind: "cron", cron: "0 9 * * 1-5" }, next: at(1, 9), last: at(0, 9), lastCode: 0, enabled: true, kind: "agent", mode: "plan", ...over });
  const hub = (jobs: ScheduleInfo[]) => {
    let items = jobs;
    return new FakeLink((c) => {
      if (c.cmd === "schedule.add") items = [...items, job({ id: "n", title: c.title as string, prompt: c.prompt as string, when: c.when as ScheduleWhen, mode: c.mode as "plan" | "auto" })];
      if (c.cmd === "schedule.update") items = items.map((j) => (j.id === c.id ? { ...j, ...(c.enabled !== undefined ? { enabled: c.enabled as boolean } : {}), ...(c.title ? { title: c.title as string, when: c.when as ScheduleWhen, prompt: c.prompt as string, mode: c.mode as "plan" | "auto" } : {}) } : j));
      if (c.cmd === "schedule.remove") items = items.filter((j) => j.id !== c.id);
      return { ev: "schedules", items };
    });
  };

  test("cron lines come back as the words of the page", () => {
    expect(cronWords("0 9 * * 1-5")).toBe("Every weekday at 9:00");
    expect(cronWords("30 22 * * *")).toBe("Every day at 22:30");
    expect(cronWords("@hourly")).toBe("Every hour");
    expect(cronWords("0 9 * * 1")).toBe("Every Monday at 9:00");
    expect(cronWords("0 9 * * 0")).toBe("Every Sunday at 9:00");
    expect(cronWords("0 9 1 * *")).toBe("Every month on the 1st at 9:00");
    expect(cronWords("0 18 22 * *")).toBe("Every month on the 22nd at 18:00");
    expect(cronWords("*/20 * * * *")).toBe("Every 20 minutes");
    expect(cronWords("0 */2 * * *")).toBe("Every 2 hours");
    expect(cronWords("5 4 2 3 *")).toBe("5 4 2 3 *");
  });
  test("the list says when each runs next and how the last run went, and its footer is the page's", async () => {
    const t = scripted([undefined]);
    await scheduleScreen(t.kit(hub([job(), job({ id: "b", title: "Tidy", enabled: false, next: undefined, last: undefined, lastCode: undefined, mode: "auto", cron: "0 22 * * *", when: { kind: "cron", cron: "0 22 * * *" } })])), () => NOW);
    const s = t.shown[0]!;
    expect(s.items.map((i) => i.label)).toEqual(["on   Morning summary", "off  Tidy", "New task"]);
    expect(s.items[0]!.hint).toBe("Every weekday at 9:00, next tomorrow 9:00, Ran fine today 9:00");
    expect(s.items[1]!.hint).toBe("Every day at 22:00, off, Not run yet, can change files");
    expect(s.frame.body).toContain("Tasks run only while navvied is running.");
  });
  test("a task that was just saved has no finished run yet, so it says it has not run", async () => {
    const t = scripted([undefined]);
    await scheduleScreen(t.kit(hub([job({ last: at(0, 12), lastCode: undefined })])), () => NOW);
    expect(t.shown[0]!.items[0]!.hint).toContain("Not run yet");
  });
  test("no tasks yet says so, with the footer", async () => {
    const t = scripted([undefined]);
    await scheduleScreen(t.kit(hub([])), () => NOW);
    expect(t.shown[0]!.frame.body!.join("\n")).toContain("No tasks yet.");
    expect(t.shown[0]!.frame.body!.join("\n")).not.toContain("A task is something");
    expect(t.shown[0]!.items.map((i) => i.label)).toEqual(["New task"]);
  });
  test("a task can be run now, turned off and on, and removed after asking", async () => {
    const l = hub([job()]);
    const t = scripted([0, "Run now", 0, "Turn it off", 0, "Turn it on", 0, "Remove it", "Keep it", 0, "Remove it", "Remove it", undefined]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.run")).toEqual([{ cmd: "schedule.run", id: "a" }]);
    expect(l.commands("schedule.update").map((c) => c.enabled)).toEqual([false, true]);
    expect(l.commands("schedule.remove")).toHaveLength(1);
    expect(t.shown.some((s) => s.title === "Remove Morning summary?")).toBe(true);
  });
  test("a new task asks name, what to do, when, the time and what it may do, then saves it", async () => {
    const l = hub([]);
    const t = scripted(["New task", "Every weekday", "9:00", "Can change files", undefined], ["Morning summary", "Summarise the new commits."]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.add")).toEqual([{ cmd: "schedule.add", title: "Morning summary", when: { kind: "cron", cron: "0 9 * * 1-5" }, prompt: "Summarise the new commits.", mode: "auto" }]);
    expect(t.shown.map((s) => s.title)).toContain("New task");
    expect(t.shown.at(-1)!.frame.notice).toContain("Task saved.");
  });
  test("a name and a task are asked for again with the page's own sentences, and a wrong cron line says what to use", async () => {
    const l = hub([]);
    const t = scripted(["New task", "Write it myself", "Only read and plan", undefined], ["", "Tidy", "", "Clean up.", "0 9 *", "0 9 * * 1-5"]);
    await scheduleScreen(t.kit(l), () => NOW);
    const notes = t.shown.flatMap((s) => s.frame.notice ?? []);
    expect(notes).toEqual(expect.arrayContaining(["Give it a name.", "Say what it should do.", "Use five fields, such as 0 9 * * 1-5."]));
    expect(l.commands("schedule.add")[0]).toMatchObject({ title: "Tidy", when: { kind: "cron", cron: "0 9 * * 1-5" } });
  });
  test("another time is typed, and a wrong one is asked again", async () => {
    const t2 = scripted(["New task", "Every day", "Another time", "Only read and plan", undefined], ["A", "B", "25:00", "7:30"]);
    const l2 = hub([]);
    await scheduleScreen(t2.kit(l2), () => NOW);
    expect(t2.shown.flatMap((s) => s.frame.notice ?? [])).toContain("Use a time such as 9:30.");
    expect(l2.commands("schedule.add")[0]).toMatchObject({ when: { kind: "cron", cron: "30 7 * * *" } });
  });
  test("every week and every month ask which day, then the time", async () => {
    const l = hub([]);
    const t = scripted(["New task", "Every week on…", "Friday", "18:00", "Only read and plan", "New task", "Every month on…", "Another day", "9:00", "Only read and plan", undefined], ["A", "B", "C", "D", "20"]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.add").map((c) => c.when)).toEqual([{ kind: "cron", cron: "0 18 * * 5" }, { kind: "cron", cron: "0 9 20 * *" }]);
  });
  test("every few minutes or hours takes a row or a typed number, and sends the interval itself", async () => {
    const l = hub([]);
    const t = scripted(["New task", "Every few minutes or hours", "15 minutes", "Only read and plan", "New task", "Every few minutes or hours", "Another number", "Only read and plan", "New task", "Every few minutes or hours", "Hour", "Only read and plan", undefined], ["A", "B", "C", "D", "soon", "2 hours", "E", "F"]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.add").map((c) => c.when)).toEqual([{ kind: "every", ms: 900_000 }, { kind: "every", ms: 7_200_000 }, { kind: "every", ms: 3_600_000 }]);
    expect(t.shown.flatMap((s) => s.frame.notice ?? [])).toContain("Use a number such as 20 minutes or 3 hours.");
  });
  test("once at a date and time sends one moment, and a moment that has passed is refused", () => {
    const w = { ...firstWhen(), kind: 4, date: "Tomorrow", time: "9:30" };
    expect(scheduleOf(w, NOW)).toEqual({ kind: "at", at: new Date(2026, 10, 26, 9, 30).getTime() });
    expect(scheduleOf({ ...w, date: "Today", time: "9:30" }, NOW)).toBe("That time has passed.");
    expect(scheduleOf({ ...w, date: "2026-02-30" }, NOW)).toBe("Use a date such as 2026-12-01.");
    expect(scheduleOf({ ...w, date: "2026-12-01", time: "7:30" }, NOW)).toEqual({ kind: "at", at: new Date(2026, 11, 1, 7, 30).getTime() });
  });
  test("a task is changed from what it is: its schedule fills the choices again", () => {
    const j = (when: ScheduleWhen) => ({ id: "a", title: "t", prompt: "p", cron: "", when, enabled: true, kind: "agent", mode: "plan" } as ScheduleInfo);
    const c = (cron: string) => j({ kind: "cron", cron });
    expect(whenOf(c("0 18 * * 5"))).toMatchObject({ kind: 2, weekday: 4, time: "18:00" });
    expect(whenOf(c("0 9 20 * *"))).toMatchObject({ kind: 3, monthday: "20", time: "9:00" });
    expect(whenOf(j({ kind: "every", ms: 1_200_000 }))).toMatchObject({ kind: 5, every: "20 minutes" });
    expect(whenOf(j({ kind: "every", ms: 7_200_000 }))).toMatchObject({ kind: 5, every: "2 hours" });
    expect(whenOf(j({ kind: "at", at: new Date(2026, 11, 1, 7, 30).getTime() }))).toMatchObject({ kind: 4, date: "2026-12-01", time: "7:30" });
    expect(whenOf(c("5 4 2 3 *"))).toMatchObject({ kind: 6, cron: "5 4 2 3 *" });
    expect(whenWords({ kind: "every", ms: 900_000 }, String)).toBe("Every 15 minutes");
    expect(whenWords({ kind: "at", at: 7 }, (ms) => `day${ms}`)).toBe("Once day7");
  });
  test("an hourly task has no time to ask, and Esc goes back one step", async () => {
    const l = hub([]);
    const t = scripted(["New task", "Every day", undefined, "Every few minutes or hours", "Hour", "Only read and plan", undefined], ["Build", "Run the build."]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(l.commands("schedule.add")[0]).toMatchObject({ when: { kind: "every", ms: 3_600_000 }, mode: "plan" });
  });
  test("changing a task starts from what it is", async () => {
    const l = hub([job()]);
    const t = scripted([0, "Change it", "Every day", "9:00", "Only read and plan", undefined], ["Daily summary", "Summarise."]);
    await scheduleScreen(t.kit(l), () => NOW);
    expect(t.shown.find((s) => s.title === "Change task" && s.items.length === 7)!.items.length).toBe(7);
  });
});
