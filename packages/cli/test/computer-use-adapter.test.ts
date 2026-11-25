import { describe, expect, test } from "bun:test";
import type { ComputerConsent } from "@navvied/engine";
import type { PermMode } from "@navvied/protocol";
import { DriverAdapter, refusalOf, type Driver } from "../src/computer-use/adapter.ts";
import { Guard } from "../src/computer-use/guard.ts";
import { NotSent, OutcomeUnknown, type CallResult } from "../src/computer-use/mcp.ts";

const ok = (structured: unknown, extra: Partial<CallResult> = {}): CallResult => ({ isError: false, text: "", structured, ...extra });
const WINDOW = { app_name: "Notes", pid: 7, title: "Todo", window_id: 70, is_on_screen: true, z_index: 0 };
const ELEMENTS = [
  { element_token: "s1:1", role: "button", label: "Save", enabled: true, frame: { x: 10, y: 20, w: 40, h: 20 } },
  { element_token: "s1:2", role: "text field", label: "Title", value: "hello" },
  { element_token: "s1:3", role: "button", label: "Delete", enabled: false, frame: { x: 100, y: 20, w: 40, h: 20 } },
];

/** A stand-in driver that records every call and answers like the real one does for what the adapter asks. */
function fake(over: Partial<Record<string, (a: Record<string, unknown>) => CallResult | Promise<CallResult>>> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const driver: Driver = {
    async call(name, args) {
      calls.push({ name, args });
      if (over[name]) return over[name]!(args);
      if (name === "list_windows") return ok({ windows: [WINDOW] });
      if (name === "get_window_state") return ok({ elements: ELEMENTS }, args.include_screenshot ? { image: { mime: "image/png", data: "AAAA" } } : {});
      return ok({ effect: "confirmed" });
    },
  };
  return { driver, calls };
}

function make(mode: PermMode = "bypass", over: Parameters<typeof fake>[0] = {}, extra: { human?: boolean; ready?: boolean } = {}) {
  const f = fake(over);
  const shown: (string | undefined)[] = [];
  const guard = new Guard({ mode: () => mode, ownApps: ["navvied"], humanHasControl: () => extra.human ?? false });
  const adapter = new DriverAdapter({
    driver: f.driver, guard, mode: { current: mode }, platform: "linux", indicator: (a) => shown.push(a),
    ready: async () => extra.ready === false ? { ok: false, refusal: { verdict: "refused", code: "permission_missing", which: "Accessibility", next: "Allow it." } } : { ok: true },
  });
  return { adapter, calls: f.calls, shown, guard };
}
const yes: ComputerConsent = async () => "once";

describe("looking", () => {
  test("a capture numbers the elements the driver gave and keeps the picture only when asked", async () => {
    const { adapter, calls } = make();
    const r = await adapter.call({ action: "capture", app: "notes", mode: "ax" });
    expect(r).toEqual({ verdict: "delivered", app: "notes", tree: '1 button "Save"\n2 text field "Title" = "hello"\n3 button "Delete" (disabled)' });
    expect(calls.find((c) => c.name === "get_window_state")!.args).toMatchObject({ pid: 7, window_id: 70, include_screenshot: false });
    const som = await adapter.call({ action: "capture", app: "notes", mode: "som" });
    expect(som.image).toEqual({ mime: "image/png", data: "AAAA" });
  });
  test("an app with no open window is refused with the step to take", async () => {
    const { adapter } = make("bypass", { list_windows: () => ok({ windows: [] }) });
    expect(await adapter.call({ action: "capture", app: "Notes" })).toMatchObject({ verdict: "refused", code: "background_unavailable", next: expect.stringContaining("no open window") });
  });
  test("a window that is not on screen is not offered", async () => {
    const { adapter } = make("bypass", { list_windows: () => ok({ windows: [{ ...WINDOW, is_on_screen: false }] }) });
    expect((await adapter.call({ action: "capture", app: "Notes" })).verdict).toBe("refused");
  });
  test("list shows windows, of one app when it is named", async () => {
    const { adapter } = make("bypass", { list_windows: () => ok({ windows: [WINDOW, { ...WINDOW, app_name: "Mail", title: "Inbox", window_id: 71, z_index: 1 }] }) });
    expect((await adapter.call({ action: "list" })).tree).toBe('1 window "Todo" of Notes\n2 window "Inbox" of Mail');
    expect((await adapter.call({ action: "list", app: "mail" })).tree).toBe('1 window "Inbox" of Mail');
  });
});

describe("the person stops the turn", () => {
  test("a stopped turn sends nothing more to the driver, and a wait in progress ends at once", async () => {
    const { adapter, calls } = make();
    const stopped = new AbortController(); stopped.abort();
    expect(await adapter.call({ action: "capture", app: "Notes" }, stopped.signal)).toMatchObject({ verdict: "refused", code: "blocked_by_policy" });
    expect(calls.length).toBe(0);
    const c = new AbortController(); const started = Date.now();
    const waiting = adapter.call({ action: "wait", seconds: 30 }, c.signal);
    setTimeout(() => c.abort(), 20);
    await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("a turn stopped in the middle of a step", () => {
  test("a driver call that is in flight is let go at once and is unverified, never replayed", async () => {
    let calls = 0;
    const { adapter } = make("bypass", { click: () => { calls++; return new Promise<CallResult>(() => undefined); } });
    await adapter.call({ action: "capture", app: "Notes" });
    const c = new AbortController();
    const step = adapter.call({ action: "click", target: 1 }, c.signal);
    setTimeout(() => c.abort(), 20);
    expect(await step).toMatchObject({ verdict: "unverified", next: expect.stringContaining("cut off") });
    expect(calls).toBe(1);
  });
  test("a long text is typed in pieces and the typing stops before the next piece when the turn is stopped", async () => {
    const c = new AbortController();
    const typed: string[] = [];
    const { adapter } = make("bypass", { type_text: (a) => { typed.push(String(a.text)); if (typed.length === 2) c.abort(); return ok({ effect: "confirmed" }); } });
    await adapter.call({ action: "capture", app: "Notes" });
    const r = await adapter.call({ action: "type", target: 2, text: "x".repeat(500) }, c.signal);
    expect(typed.map((t) => t.length)).toEqual([120, 120]);
    expect(r).toMatchObject({ verdict: "unverified", next: expect.stringContaining("cut off") });
  });
  test("a short text is one call and a whole long one arrives complete when nobody stops it", async () => {
    const typed: string[] = [];
    const { adapter } = make("bypass", { type_text: (a) => { typed.push(String(a.text)); return ok({ effect: "confirmed" }); } });
    await adapter.call({ action: "capture", app: "Notes" });
    expect((await adapter.call({ action: "type", target: 2, text: "hi" })).verdict).toBe("delivered");
    expect((await adapter.call({ action: "type", target: 2, text: "y".repeat(300) })).verdict).toBe("delivered");
    expect(typed.map((t) => t.length)).toEqual([2, 120, 120, 60]);
    expect((await adapter.call({ action: "type", target: 2, text: "" })).verdict).toBe("delivered");
  });
});

describe("the mode of the conversation", () => {
  test("each call tells the helper the conversation's mode, and a mode that changes is obeyed at once", async () => {
    const f = fake(); const holder = { current: "ask" as PermMode };
    const a = new DriverAdapter({ driver: f.driver, mode: holder, guard: new Guard({ mode: () => holder.current, ownApps: [], humanHasControl: () => false }), ready: async () => ({ ok: true }), platform: "linux" });
    expect(await a.call({ action: "capture", app: "Notes" }, undefined, undefined, "plan")).toMatchObject({ code: "blocked_by_policy" });
    expect((await a.call({ action: "capture", app: "Notes" }, undefined, undefined, "bypass")).verdict).toBe("delivered");
    expect(await a.call({ action: "click", target: 1 }, undefined, undefined, "plan")).toMatchObject({ code: "blocked_by_policy" });
  });
});

describe("acting", () => {
  test("a click on a number goes to that element's token in the captured window, in the background", async () => {
    const { adapter, calls } = make();
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "click", target: 1 })).toEqual({ verdict: "delivered", app: "Notes" });
    expect(calls.at(-1)).toEqual({ name: "click", args: { pid: 7, window_id: 70, delivery_mode: "background", element_token: "s1:1" } });
  });
  test("right and double click, held keys, typing into an element, a shortcut and a scroll are the driver's own arguments", async () => {
    const { adapter, calls } = make();
    await adapter.call({ action: "capture", app: "Notes" });
    await adapter.call({ action: "click", target: 1, button: "right", count: 2, keys: "shift+cmd" });
    expect(calls.at(-1)!.args).toMatchObject({ button: "right", count: 2, modifier: ["shift", "cmd"] });
    await adapter.call({ action: "type", target: 2, text: "hi" });
    expect(calls.at(-1)).toMatchObject({ name: "type_text", args: { element_token: "s1:2", text: "hi" } });
    await adapter.call({ action: "key", keys: "ctrl-Shift+S" });
    expect(calls.at(-1)).toMatchObject({ name: "hotkey", args: { keys: ["ctrl", "shift", "s"] } });
    await adapter.call({ action: "scroll", direction: "up", amount: 99 });
    expect(calls.at(-1)).toMatchObject({ name: "scroll", args: { direction: "up", amount: 50, by: "line" } });
  });
  test("one key is press_key, a combination is hotkey", async () => {
    const { adapter, calls } = make();
    await adapter.call({ action: "capture", app: "Notes" });
    await adapter.call({ action: "key", keys: "Escape" });
    expect(calls.at(-1)).toMatchObject({ name: "press_key", args: { key: "escape" } });
    await adapter.call({ action: "key", keys: "cmd+s" });
    expect(calls.at(-1)).toMatchObject({ name: "hotkey", args: { keys: ["cmd", "s"] } });
  });
  test("a place in pixels needs a picture of the window: one is taken first when the capture had none, and only then", async () => {
    const { adapter, calls } = make();
    await adapter.call({ action: "capture", app: "Notes", mode: "ax" });
    await adapter.call({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
    const names = calls.map((c) => `${c.name}${c.args.include_screenshot ? "+picture" : ""}`);
    expect(names.slice(-3)).toEqual(["get_window_state", "get_window_state+picture", "drag"]);
    const before = calls.length;
    await adapter.call({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
    expect(calls.slice(before).map((c) => c.name)).toEqual(["drag"]);
    const { adapter: a2, calls: c2 } = make();
    await a2.call({ action: "capture", app: "Notes", mode: "som" });
    await a2.call({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
    expect(c2.filter((c) => c.name === "get_window_state").length).toBe(1);
  });
  test("a drag between two elements uses the middle of each, or pixels when given", async () => {
    const { adapter, calls } = make();
    await adapter.call({ action: "capture", app: "Notes" });
    await adapter.call({ action: "drag", target: 1, to: 3 });
    expect(calls.at(-1)).toMatchObject({ name: "drag", args: { from_x: 30, from_y: 30, to_x: 120, to_y: 30 } });
    await adapter.call({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 });
    expect(calls.at(-1)!.args).toMatchObject({ from_x: 1, from_y: 2, to_x: 3, to_y: 4 });
    expect(await adapter.call({ action: "drag", target: 2, to: 1 })).toMatchObject({ verdict: "refused" });
  });
  test("input before any capture is refused, and the numbers of an earlier app are not used for another", async () => {
    const { adapter } = make();
    expect(await adapter.call({ action: "click", target: 1 })).toMatchObject({ verdict: "refused", code: "input_target_mismatch" });
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "click", app: "Mail", target: 1 })).toMatchObject({ verdict: "refused", code: "input_target_mismatch" });
  });
  test("an effect the driver could not confirm is unverified", async () => {
    const { adapter } = make("bypass", { click: () => ok({ effect: "unconfirmed" }) });
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "click", target: 1 })).toMatchObject({ verdict: "unverified", next: expect.stringContaining("do not send it twice") });
  });
  test("a driver that stops or does not answer during input leaves the outcome unknown; one that was never reached is a refusal", async () => {
    let how: "unknown" | "unsent" = "unknown";
    const { adapter } = make("bypass", { click: () => { throw how === "unknown" ? new OutcomeUnknown("x") : new NotSent("y"); } });
    await adapter.call({ action: "capture", app: "Notes" });
    expect((await adapter.call({ action: "click", target: 1 })).verdict).toBe("unverified");
    how = "unsent";
    expect(await adapter.call({ action: "click", target: 1 })).toMatchObject({ verdict: "refused", code: "background_unavailable" });
  });
  test("a wait is cut to thirty seconds and does not touch the driver", async () => {
    const f = fake(); const slept: number[] = [];
    const a = new DriverAdapter({ driver: f.driver, mode: { current: "ask" }, guard: new Guard({ mode: () => "ask", ownApps: [], humanHasControl: () => false }), ready: async () => ({ ok: true }), platform: "linux", sleep: async (ms) => { slept.push(ms); } });
    await a.call({ action: "wait", seconds: 99 }); await a.call({ action: "wait" });
    expect(slept).toEqual([30000, 500]);
    expect(f.calls.length).toBe(0);
  });
});

describe("what the person decides", () => {
  test("ask mode: nothing is sent until the person answers; no ends it; once allows that step only; app allows the app", async () => {
    const { adapter, calls } = make("ask");
    expect(await adapter.call({ action: "capture", app: "Notes" })).toMatchObject({ verdict: "refused", code: "blocked_by_policy" });
    expect(calls.length).toBe(0);
    expect((await adapter.call({ action: "capture", app: "Notes" }, undefined, async () => "no")).verdict).toBe("refused");
    expect(calls.length).toBe(0);
    expect((await adapter.call({ action: "capture", app: "Notes" }, undefined, yes)).verdict).toBe("delivered");
    const asked: string[] = [];
    await adapter.call({ action: "capture", app: "Notes" }, undefined, async (a) => { asked.push(`${a.about}:${a.app}`); return "app"; });
    await adapter.call({ action: "capture", app: "Notes" }, undefined, async (a) => { asked.push("again"); return "once"; });
    expect(asked).toEqual(["capture:Notes"]);
  });
  test("a click asks every time in ask mode, with the app named", async () => {
    const { adapter } = make("ask");
    await adapter.call({ action: "capture", app: "Notes" }, undefined, async () => "app");
    const asked: string[] = [];
    await adapter.call({ action: "click", target: 1 }, undefined, async (a) => { asked.push(`${a.about}:${a.app}`); return "once"; });
    await adapter.call({ action: "click", target: 1 }, undefined, async (a) => { asked.push(`${a.about}:${a.app}`); return "once"; });
    expect(asked).toEqual(["input:Notes", "input:Notes"]);
  });
  test("an app that cannot be used in the background is asked about, louder, and is then used in front only if the person says yes", async () => {
    let n = 0;
    const { adapter, calls } = make("bypass", { click: (a) => { n++; return a.delivery_mode === "background" ? { isError: true, text: "background_unavailable", structured: { code: "background_unavailable" } } : ok({ effect: "confirmed" }); } });
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "click", target: 1 }, undefined, async (a) => a.about === "foreground" ? "no" : "once")).toMatchObject({ verdict: "refused", code: "background_unavailable" });
    expect(n).toBe(1);
    expect((await adapter.call({ action: "click", target: 1 }, undefined, async () => "once")).verdict).toBe("delivered");
    expect(calls.at(-1)!.args.delivery_mode).toBe("foreground");
  });
  test("a foreground that cannot be had either is told as it is: the app cannot be used, and the person is told", async () => {
    const { adapter } = make("bypass", { click: (a) => ({ isError: true, text: "x", structured: { code: a.delivery_mode === "background" ? "background_unavailable" : "foreground_unavailable" } }) });
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "click", target: 1 }, undefined, async () => "once")).toMatchObject({ verdict: "refused", code: "background_unavailable", next: expect.stringContaining("could not be brought") });
  });
  test("the hard blocks and the person's own windows are refused before the driver or the person is asked", async () => {
    const { adapter, calls } = make("bypass");
    await adapter.call({ action: "capture", app: "Notes" });
    expect(await adapter.call({ action: "key", keys: "cmd+shift+backspace" })).toMatchObject({ code: "blocked_by_policy" });
    expect(await adapter.call({ action: "capture", app: "navvied" })).toMatchObject({ code: "blocked_by_policy" });
    expect(calls.filter((c) => c.name === "hotkey").length).toBe(0);
  });
  test("Stop: nothing reaches the driver until the person lets the agent go on", async () => {
    const { adapter, calls } = make();
    adapter.halt();
    expect(await adapter.call({ action: "capture", app: "Notes" })).toMatchObject({ verdict: "refused", code: "human_has_control" });
    expect(calls.length).toBe(0);
    adapter.resume();
    expect((await adapter.call({ action: "capture", app: "Notes" })).verdict).toBe("delivered");
  });
  test("the indicator names the app while a step runs and is cleared after, even when it fails", async () => {
    const { adapter, shown } = make("bypass", { list_windows: () => { throw new Error("boom"); } });
    await expect(adapter.call({ action: "capture", app: "Notes" })).rejects.toThrow("boom");
    expect(shown).toEqual(["Notes", undefined]);
  });
});

describe("what the system says", () => {
  test("a system that is not ready answers with its own refusal before anything is sent", async () => {
    const { adapter, calls } = make("bypass", {}, { ready: false });
    expect(await adapter.call({ action: "capture", app: "Notes" })).toMatchObject({ code: "permission_missing", which: "Accessibility" });
    expect(calls.length).toBe(0);
  });
  test("the driver's failures are put into the closed words from its structured code, never from the words of its text", () => {
    const bad = (code?: string, text = "", extra: object = {}): CallResult => ({ isError: true, text, structured: code ? { code, ...extra } : null });
    expect(refusalOf(bad("background_unavailable"))).toMatchObject({ code: "background_unavailable" });
    expect(refusalOf(bad("foreground_unavailable"))).toMatchObject({ code: "background_unavailable", next: expect.stringContaining("front") });
    expect(refusalOf(bad("target_occluded"))).toMatchObject({ code: "background_occluded" });
    expect(refusalOf(bad("background_uipi_blocked"))).toMatchObject({ code: "background_uipi_blocked" });
    expect(refusalOf(bad("permission_missing", "", { which: "Screen Recording" }))).toMatchObject({ code: "permission_missing", which: "Screen Recording" });
    expect(refusalOf(bad("screenshot_context_missing"))).toMatchObject({ code: "input_target_mismatch" });
    expect(refusalOf(bad("tool_invocation_failed", "Accessibility permission is not granted; the window is occluded; UIPI; foreground"))).toBeUndefined();
    expect(refusalOf(bad(undefined, "background_unavailable permission occluded"))).toBeUndefined();
  });
  test("a driver error it cannot name is unverified for input and a plain refusal for looking; neither carries the driver's words", async () => {
    const boom = () => ({ isError: true, text: "/Users/x/secret path failed: errno 5", structured: { code: "tool_invocation_failed" } }) as CallResult;
    const { adapter } = make("bypass", { click: boom, get_window_state: boom });
    const look = await adapter.call({ action: "capture", app: "Notes" });
    expect(look).toMatchObject({ verdict: "refused", code: "background_unavailable" });
    expect(JSON.stringify(look)).not.toContain("secret");
    const { adapter: a2 } = make("bypass", { click: boom });
    await a2.call({ action: "capture", app: "Notes" });
    const act = await a2.call({ action: "click", target: 1 });
    expect(act.verdict).toBe("unverified");
    expect(JSON.stringify(act)).not.toContain("secret");
  });
});
