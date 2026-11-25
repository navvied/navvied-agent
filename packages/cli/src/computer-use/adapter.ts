import type { ComputerCall, ComputerConsent, ComputerHelper, ComputerResult } from "@navvied/engine";
import type { PermMode } from "@navvied/protocol";
import { clampWait, Guard, type Refusal } from "./guard.ts";
import { NotSent, OutcomeUnknown, type CallResult } from "./mcp.ts";

/** The tool protocol of the driver, as far as the adapter needs it. */
export interface Driver { call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult> }

/** Whether this computer can be driven now: started, allowed by the system, and a kind the driver works on. A refusal says why in the helper's own terms. */
export type Readiness = { ok: true } | { ok: false; refusal: ComputerResult };

export interface AdapterInput {
  driver: Driver;
  ready: () => Promise<Readiness>;
  guard: Guard;
  /** The permission mode the guard reads, which each call sets from the conversation's (`ask` until a call says otherwise). */
  mode: { current: PermMode };
  /** The person's window shows which app is being used, with Stop, while this is called with the app; called with `undefined` when the agent lets go. */
  indicator?: (app: string | undefined) => void;
  /** Tells the driver how a keyboard shortcut is spelled on this system. */
  platform: string;
  /** What the driver answered, as it answered, for a check that has to see why a step failed. Never for a conversation: the model never reads it. */
  trace?: (call: { tool: string; args: Record<string, unknown>; result: CallResult }) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface Win { pid: number; windowId: number; app: string; title: string }
interface Element { token: string; frame?: { x: number; y: number; w: number; h: number } }

const NEXT_GONE = (app: string) => `${app} has no open window. Ask the person to open it, then capture again.`;
const NEXT_UNKNOWN = "The step was sent and could not be confirmed. Capture the app and look before you act again; do not send it twice.";
const NEXT_CUT = "The step was cut off when the person stopped the turn, and it is not known how far it got. Capture the app and look before you act again.";
const NEXT_FAILED = "This could not be done. Capture the app again; if it fails again, tell the person.";

const refused = (code: Refusal & ComputerResult["code"], next: string, extra: Partial<ComputerResult> = {}): ComputerResult => ({ verdict: "refused", code: code as NonNullable<ComputerResult["code"]>, next, ...extra });

/** The driver's own closed codes, as it puts them in `structuredContent.code`, and what each means to the model. What its text says is never read: it is for people, and it names paths and system calls. */
const DRIVER_CODES: Record<string, { code: NonNullable<ComputerResult["code"]>; next: string }> = {
  background_unavailable: { code: "background_unavailable", next: "This app cannot be used without bringing it to the front of the screen. Tell the person and stop." },
  foreground_unavailable: { code: "background_unavailable", next: "This app can only be used in front of the screen, and it could not be brought there. Tell the person and stop." },
  wm_chord_unavailable: { code: "background_unavailable", next: "That shortcut belongs to the desktop and cannot be sent to an app. Tell the person and stop." },
  background_occluded: { code: "background_occluded", next: "The window is hidden. Ask the person to show it, then capture again." },
  target_occluded: { code: "background_occluded", next: "Another window covers that place. Ask the person to move it, then capture again." },
  background_uipi_blocked: { code: "background_uipi_blocked", next: "This app runs with more rights than navvied and cannot be controlled. Tell the person and stop." },
  permission_missing: { code: "permission_missing", next: "The person must allow it in the system settings. Tell them and stop." },
  screenshot_context_missing: { code: "input_target_mismatch", next: "Capture the app again, then act." },
  point_outside_window: { code: "input_target_mismatch", next: "That place is outside the window. Capture the app again, then act." },
  element_not_found: { code: "input_target_mismatch", next: "Capture the app again, then use the new numbers." },
};

/** What a driver's failure means in the closed words the model is given, from its structured code only. */
export function refusalOf(r: CallResult): { code: NonNullable<ComputerResult["code"]>; next: string; which?: string } | undefined {
  const code = (r.structured as { code?: unknown } | undefined)?.code;
  const known = typeof code === "string" ? DRIVER_CODES[code] : undefined;
  if (!known) return undefined;
  const which = (r.structured as { which?: unknown } | undefined)?.which;
  return { ...known, ...(known.code === "permission_missing" && typeof which === "string" ? { which } : {}) };
}

/** A pause that ends the moment the person stops the turn. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });

const TYPE_PIECE = 120;
const CUT = Symbol("cut");
const cut = (signal: AbortSignal): Promise<typeof CUT> => new Promise((resolve) => { if (signal.aborted) resolve(CUT); else signal.addEventListener("abort", () => resolve(CUT), { once: true }); });

const words = (keys: string): string[] => keys.split(/\s*[+-]\s*/).map((k) => k.trim().toLowerCase()).filter(Boolean);

export class DriverAdapter implements ComputerHelper {
  private window?: Win;
  private elements = new Map<number, Element>();
  /** Whether the last read of the window had a picture: places in pixels mean something only against one. */
  private shot = false;
  private halted = false;

  constructor(private i: AdapterInput) {}

  /** The person's Stop: nothing more happens until they let the agent go on. */
  halt(): void { this.halted = true; }
  resume(): void { this.halted = false; }
  get isHalted(): boolean { return this.halted; }
  /** Everything this conversation was allowed or knew of the screen is dropped. */
  forget(): void { this.i.guard.reset(); this.window = undefined; this.elements.clear(); this.halted = false; }

  async call(c: ComputerCall, signal?: AbortSignal, consent?: ComputerConsent, mode?: PermMode): Promise<ComputerResult> {
    const g = this.i.guard;
    if (mode) this.i.mode.current = mode;
    if (this.halted) return refused("human_has_control", "The person has stopped you. Wait until they let you go on.");
    if (signal?.aborted) return refused("blocked_by_policy", "The person stopped this turn. Do nothing more on the screen.");
    const d = g.decide({ action: c.action, ...(c.app ? { app: c.app } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.keys ? { keys: c.keys } : {}) });
    if (d.kind === "refuse") return refused(d.code as never, d.next);
    if (d.kind === "ask") {
      const answer = consent ? await consent({ app: d.app, about: d.about }) : "no";
      if (answer === "no") return refused("blocked_by_policy", "The person said no. Do not try again: tell them what you could not do.");
      if (answer === "app") g.approve(d.app);
    }
    const ready = await this.i.ready();
    if (!ready.ok) return ready.refusal;

    const app = c.app?.trim() || this.window?.app;
    this.i.indicator?.(app);
    try {
      const r = await this.run(c, app, consent, signal);
      g.settle({ action: c.action, ...(app ? { app } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.keys ? { keys: c.keys } : {}) }, r.verdict === "delivered");
      return r;
    } finally { this.i.indicator?.(undefined); }
  }

  private async run(c: ComputerCall, app: string | undefined, consent?: ComputerConsent, signal?: AbortSignal): Promise<ComputerResult> {
    switch (c.action) {
      case "wait": { await (this.i.sleep ?? ((ms) => pause(ms, signal)))(clampWait((c.seconds ?? 0.5) * 1000)); return { verdict: "delivered" }; }
      case "list": return this.list(c.app);
      case "capture": return this.capture(app!, c.mode ?? "ax");
      default: return this.input(c, app, consent, "background", signal);
    }
  }

  private async windows(filter?: string): Promise<{ wins: Win[] } | { fail: ComputerResult }> {
    const r = await this.safe("list_windows", {});
    if ("fail" in r) return r;
    const raw = ((r.ok.structured as { windows?: Record<string, unknown>[] } | undefined)?.windows ?? []).filter((w) => w.is_on_screen !== false);
    const wins = raw.filter((w) => typeof w.pid === "number" && typeof w.window_id === "number")
      .map((w) => ({ pid: w.pid as number, windowId: w.window_id as number, app: String(w.app_name ?? ""), title: String(w.title ?? ""), z: typeof w.z_index === "number" ? w.z_index : 1e9 }))
      .filter((w) => !filter || `${w.app} ${w.title}`.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.z - b.z);
    return { wins };
  }

  private async list(app?: string): Promise<ComputerResult> {
    const w = await this.windows(app);
    if ("fail" in w) return w.fail;
    const tree = w.wins.map((x, n) => `${n + 1} window "${x.title}" of ${x.app}`).join("\n");
    return { verdict: "delivered", tree };
  }

  private async capture(app: string, mode: "ax" | "som" | "vision"): Promise<ComputerResult> {
    const w = await this.windows(app);
    if ("fail" in w) return w.fail;
    const win = w.wins[0];
    if (!win) return refused("background_unavailable", NEXT_GONE(app), { app });
    const r = await this.safe("get_window_state", { pid: win.pid, window_id: win.windowId, tree_format: "both", include_screenshot: mode !== "ax", ...(mode === "vision" ? { capture_mode: "vision" } : {}), timeout_ms: 8000 });
    if ("fail" in r) return r.fail;
    this.window = { pid: win.pid, windowId: win.windowId, app: win.app || app, title: win.title };
    this.elements = parseElements(r.ok);
    this.shot = mode !== "ax";
    const tree = [...this.elements.keys()].sort((a, b) => a - b).map((n) => this.lineOf(n, r.ok)).join("\n");
    return { verdict: "delivered", app, ...(tree ? { tree } : {}), ...(r.ok.image ? { image: r.ok.image } : {}) };
  }

  private lineOf(n: number, r: CallResult): string {
    const e = (r.structured as { elements?: Record<string, unknown>[] } | undefined)?.elements?.find((x) => indexOf(x) === n);
    if (!e) return `${n} element`;
    const label = String(e.label ?? e.title ?? e.name ?? "").trim();
    const value = e.value !== undefined && e.value !== null && String(e.value) !== "" ? ` = "${String(e.value).slice(0, 80)}"` : "";
    return `${n} ${String(e.role ?? "element")}${label ? ` "${label.slice(0, 80)}"` : ""}${value}${e.enabled === false ? " (disabled)" : ""}`;
  }

  private place(c: ComputerCall, which: "from" | "to"): { x: number; y: number } | undefined {
    const n = which === "from" ? c.target : c.to;
    if (n !== undefined) { const f = this.elements.get(n)?.frame; return f ? { x: Math.round(f.x + f.w / 2), y: Math.round(f.y + f.h / 2) } : undefined; }
    const x = which === "from" ? c.x : c.to_x, y = which === "from" ? c.y : c.to_y;
    return x !== undefined && y !== undefined ? { x, y } : undefined;
  }

  private async input(c: ComputerCall, app: string | undefined, consent?: ComputerConsent, delivery: "background" | "foreground" = "background", signal?: AbortSignal): Promise<ComputerResult> {
    const win = this.window;
    if (!win || !app) return refused("input_target_mismatch", "Capture an app first.");
    const base = { pid: win.pid, window_id: win.windowId, delivery_mode: delivery };
    const byPixels = c.action === "drag" || ((c.action === "click" || c.action === "scroll") && c.target === undefined && c.x !== undefined);
    if (byPixels && !this.shot) {
      // A place in pixels is a place in a picture of the window: take one (the model is not shown it) before the step.
      const seen = await this.safe("get_window_state", { pid: win.pid, window_id: win.windowId, tree_format: "elements", include_screenshot: true, timeout_ms: 8000 }, false, signal);
      if ("fail" in seen) return seen.fail;
      this.shot = true;
    }
    const element = c.target !== undefined ? this.elements.get(c.target) : undefined;
    const held = c.keys && c.action !== "key" ? { modifier: words(c.keys) } : {};
    let name: string, args: Record<string, unknown>;
    switch (c.action) {
      case "click": {
        const at = element ? { element_token: element.token } : this.place(c, "from");
        if (!at) return refused("input_target_mismatch", "That element has no place on screen. Capture again.", { app });
        name = "click"; args = { ...base, ...at, ...held, ...(c.button ? { button: c.button } : {}), ...(c.count === 2 ? { count: 2 } : {}) };
        break;
      }
      case "drag": {
        const from = this.place(c, "from"), to = this.place(c, "to");
        if (!from || !to) return refused("input_target_mismatch", "Both ends of a drag need a place on screen. Capture again.", { app });
        name = "drag"; args = { ...base, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, ...held };
        break;
      }
      case "type": return this.typeText(base, element, c.text ?? "", app, signal);
      case "key": { const ks = words(c.keys ?? ""); if (ks.length === 1) { name = "press_key"; args = { ...base, key: ks[0] }; } else { name = "hotkey"; args = { ...base, keys: ks }; } break; }
      case "scroll": name = "scroll"; args = { ...base, direction: c.direction ?? "down", amount: Math.max(1, Math.min(50, c.amount ?? 3)), by: "line", ...(element ? { element_token: element.token } : {}) }; break;
      default: return refused("blocked_by_policy", "This step does not exist.");
    }
    const r = await this.safe(name, args, true, signal);
    if ("fail" in r) {
      if (r.fail.code === "background_unavailable" && delivery === "background" && consent && (await consent({ app, about: "foreground" })) !== "no") return this.input(c, app, consent, "foreground", signal);
      return r.fail;
    }
    const effect = (r.ok.structured as { effect?: unknown } | undefined)?.effect;
    if (typeof effect === "string" && /unconfirmed|unknown|not_confirmed/.test(effect)) return { verdict: "unverified", next: NEXT_UNKNOWN, app };
    return { verdict: "delivered", app };
  }

  /** Text goes in pieces, so a person who stops the turn stops the typing at the next piece: what was already typed stays, and the answer says it is not known how far it got. */
  private async typeText(base: Record<string, unknown>, element: Element | undefined, text: string, app: string, signal?: AbortSignal): Promise<ComputerResult> {
    for (let at = 0; at === 0 || at < text.length; at += TYPE_PIECE) {
      if (at > 0 && signal?.aborted) return { verdict: "unverified", next: NEXT_CUT, app };
      const r = await this.safe("type_text", { ...base, text: text.slice(at, at + TYPE_PIECE), ...(element ? { element_token: element.token } : {}) }, true, signal);
      if ("fail" in r) return r.fail;
      const effect = (r.ok.structured as { effect?: unknown } | undefined)?.effect;
      if (typeof effect === "string" && /unconfirmed|unknown|not_confirmed/.test(effect)) return { verdict: "unverified", next: NEXT_UNKNOWN, app };
    }
    return { verdict: "delivered", app };
  }

  /** One call of the driver. A failure the driver names becomes a refusal; one that leaves it unknown whether the step happened becomes `unverified`, for input, and is never repeated. */
  private async safe(name: string, args: Record<string, unknown>, input = false, signal?: AbortSignal): Promise<{ ok: CallResult } | { fail: ComputerResult }> {
    if (this.halted) return { fail: refused("human_has_control", "The person has stopped you. Wait until they let you go on.") };
    try {
      const sent = this.i.driver.call(name, args, 30_000);
      sent.catch(() => undefined);
      // A stopped turn does not wait for the driver: the call is let go, and whether it happened is not known.
      const r = signal ? await Promise.race([sent, cut(signal)]) : await sent;
      if (r !== CUT) this.i.trace?.({ tool: name, args, result: r });
      if (r === CUT) return { fail: input ? { verdict: "unverified", next: NEXT_CUT } : refused("blocked_by_policy", "The person stopped this turn. Do nothing more on the screen.") };
      if (!r.isError) return { ok: r };
      const known = refusalOf(r);
      if (known) return { fail: refused(known.code, known.next, known.which ? { which: known.which } : {}) };
      return { fail: input ? { verdict: "unverified", next: NEXT_UNKNOWN } : refused("background_unavailable", NEXT_FAILED) };
    } catch (e) {
      if (e instanceof NotSent) return { fail: refused("background_unavailable", "The screen helper is not running. Tell the person.") };
      if (e instanceof OutcomeUnknown) return { fail: input ? { verdict: "unverified", next: NEXT_UNKNOWN } : refused("background_unavailable", NEXT_FAILED) };
      throw e;
    }
  }
}

/** The number an element goes by: the one the driver gave it, which is also the end of its token. */
const indexOf = (e: Record<string, unknown>): number | undefined => {
  if (typeof e.element_index === "number") return e.element_index;
  const t = typeof e.element_token === "string" ? /:(\d+)$/.exec(e.element_token)?.[1] : undefined;
  return t === undefined ? undefined : Number(t);
};

/** The numbered elements of a capture, from the driver's structured list. */
export function parseElements(r: CallResult): Map<number, Element> {
  const out = new Map<number, Element>();
  const list = (r.structured as { elements?: Record<string, unknown>[] } | undefined)?.elements;
  for (const e of list ?? []) {
    const n = indexOf(e), token = e.element_token;
    if (n === undefined || typeof token !== "string") continue;
    const f = e.frame as { x?: number; y?: number; w?: number; h?: number } | undefined;
    out.set(n, { token, ...(f && [f.x, f.y, f.w, f.h].every((v) => typeof v === "number") ? { frame: f as Element["frame"] } : {}) });
  }
  return out;
}
