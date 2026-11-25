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
  sleep?: (ms: number) => Promise<void>;
}

interface Win { pid: number; windowId: number; app: string; title: string }
interface Element { token: string; frame?: { x: number; y: number; w: number; h: number } }

const NEXT_GONE = (app: string) => `${app} has no open window. Ask the person to open it, then capture again.`;
const NEXT_UNKNOWN = "The step was sent and could not be confirmed. Capture the app and look before you act again; do not send it twice.";
const NEXT_FAILED = "This could not be done. Capture the app again; if it fails again, tell the person.";

const refused = (code: Refusal & ComputerResult["code"], next: string, extra: Partial<ComputerResult> = {}): ComputerResult => ({ verdict: "refused", code: code as NonNullable<ComputerResult["code"]>, next, ...extra });

/** What a driver's failure says, in the closed words the model is given: never the operating system's own text. */
export function refusalOf(r: CallResult): { code: NonNullable<ComputerResult["code"]>; which?: string } | undefined {
  const said = `${JSON.stringify(r.structured ?? "")} ${r.text}`.toLowerCase();
  if (/permission|not trusted|accessibility.*(denied|not granted|disabled)|screen recording/.test(said)) return { code: "permission_missing", which: /screen recording/.test(said) ? "Screen Recording" : "Accessibility" };
  if (/uipi|higher integrity|elevated/.test(said)) return { code: "background_uipi_blocked" };
  if (/occluded|covered by|minimi[sz]ed|not on screen/.test(said)) return { code: "background_occluded" };
  if (/background_unavailable|wm_chord_unavailable|foreground/.test(said) && r.isError) return { code: "background_unavailable" };
  return undefined;
}

const words = (keys: string): string[] => keys.split(/\s*[+-]\s*/).map((k) => k.trim().toLowerCase()).filter(Boolean);

export class DriverAdapter implements ComputerHelper {
  private window?: Win;
  private elements = new Map<number, Element>();
  private halted = false;

  constructor(private i: AdapterInput) {}

  /** The person's Stop: nothing more happens until they let the agent go on. */
  halt(): void { this.halted = true; }
  resume(): void { this.halted = false; }
  get isHalted(): boolean { return this.halted; }
  /** Everything this conversation was allowed or knew of the screen is dropped. */
  forget(): void { this.i.guard.reset(); this.window = undefined; this.elements.clear(); this.halted = false; }

  async call(c: ComputerCall, _signal?: AbortSignal, consent?: ComputerConsent, mode?: PermMode): Promise<ComputerResult> {
    const g = this.i.guard;
    if (mode) this.i.mode.current = mode;
    if (this.halted) return refused("human_has_control", "The person has stopped you. Wait until they let you go on.");
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
      const r = await this.run(c, app, consent);
      g.settle({ action: c.action, ...(app ? { app } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.keys ? { keys: c.keys } : {}) }, r.verdict === "delivered");
      return r;
    } finally { this.i.indicator?.(undefined); }
  }

  private async run(c: ComputerCall, app: string | undefined, consent?: ComputerConsent): Promise<ComputerResult> {
    switch (c.action) {
      case "wait": { await (this.i.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(clampWait((c.seconds ?? 0.5) * 1000)); return { verdict: "delivered" }; }
      case "list": return this.list(c.app);
      case "capture": return this.capture(app!, c.mode ?? "ax");
      default: return this.input(c, app, consent);
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

  private async input(c: ComputerCall, app: string | undefined, consent?: ComputerConsent, delivery: "background" | "foreground" = "background"): Promise<ComputerResult> {
    const win = this.window;
    if (!win || !app) return refused("input_target_mismatch", "Capture an app first.");
    const base = { pid: win.pid, window_id: win.windowId, delivery_mode: delivery };
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
      case "type": name = "type_text"; args = { ...base, text: c.text ?? "", ...(element ? { element_token: element.token } : {}) }; break;
      case "key": name = "hotkey"; args = { ...base, keys: words(c.keys ?? "") }; break;
      case "scroll": name = "scroll"; args = { ...base, direction: c.direction ?? "down", amount: Math.max(1, Math.min(50, c.amount ?? 3)), by: "line", ...(element ? { element_token: element.token } : {}) }; break;
      default: return refused("blocked_by_policy", "This step does not exist.");
    }
    const r = await this.safe(name, args, true);
    if ("fail" in r) {
      if (r.fail.code === "background_unavailable" && delivery === "background" && consent && (await consent({ app, about: "foreground" })) !== "no") return this.input(c, app, consent, "foreground");
      return r.fail;
    }
    const effect = (r.ok.structured as { effect?: unknown } | undefined)?.effect;
    if (typeof effect === "string" && /unconfirmed|unknown|not_confirmed/.test(effect)) return { verdict: "unverified", next: NEXT_UNKNOWN, app };
    return { verdict: "delivered", app };
  }

  /** One call of the driver. A failure the driver names becomes a refusal; one that leaves it unknown whether the step happened becomes `unverified`, for input, and is never repeated. */
  private async safe(name: string, args: Record<string, unknown>, input = false): Promise<{ ok: CallResult } | { fail: ComputerResult }> {
    if (this.halted) return { fail: refused("human_has_control", "The person has stopped you. Wait until they let you go on.") };
    try {
      const r = await this.i.driver.call(name, args, 30_000);
      if (!r.isError) return { ok: r };
      const known = refusalOf(r);
      if (known) return { fail: refused(known.code, known.code === "permission_missing" ? `The person must allow ${known.which ?? "it"} in the system settings. Tell them and stop.` : refusalNext(known.code), known.which ? { which: known.which } : {}) };
      return { fail: input ? { verdict: "unverified", next: NEXT_UNKNOWN } : refused("background_unavailable", NEXT_FAILED) };
    } catch (e) {
      if (e instanceof NotSent) return { fail: refused("background_unavailable", "The screen helper is not running. Tell the person.") };
      if (e instanceof OutcomeUnknown) return { fail: input ? { verdict: "unverified", next: NEXT_UNKNOWN } : refused("background_unavailable", NEXT_FAILED) };
      throw e;
    }
  }
}

function refusalNext(code: NonNullable<ComputerResult["code"]>): string {
  return code === "background_occluded" ? "The window is hidden. Ask the person to show it, then capture again." : code === "background_uipi_blocked" ? "This app runs with more rights than navvied and cannot be controlled. Tell the person and stop." : NEXT_FAILED;
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
