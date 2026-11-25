import type { PermMode } from "@navvied/protocol";

/** What decides, before the driver is asked anything, whether a call of the `computer` tool may happen. The host owns it, so a run without the desktop app cannot skip it. */
export type Action = "capture" | "click" | "type" | "key" | "scroll" | "list" | "wait";

export const REFUSALS = ["background_unavailable", "background_occluded", "background_uipi_blocked", "human_has_control", "input_target_mismatch", "permission_missing", "blocked_by_policy", "stale_target"] as const;
export type Refusal = (typeof REFUSALS)[number];

export interface Call { action: Action; app?: string; text?: string; keys?: string }

export type Decision =
  | { kind: "allow" }
  | { kind: "ask"; about: "capture" | "input"; app: string }
  | { kind: "refuse"; code: Refusal; next: string };

const FREE = new Set<Action>(["list", "wait"]);

const ALIASES: Record<string, string> = { command: "cmd", control: "ctrl", alt: "option", "⌘": "cmd", "⌥": "option", windows: "win", super: "win", meta: "win", del: "delete" };
/** Key combinations that log out, lock, empty the trash or close the session. Held back in every mode: a speed bump against a careless disaster, not a boundary. */
const BLOCKED_KEYS: ReadonlySet<string>[] = [
  ["cmd", "shift", "backspace"], ["cmd", "option", "backspace"], ["cmd", "ctrl", "q"], ["cmd", "shift", "q"], ["cmd", "option", "shift", "q"],
  ["win", "l"], ["ctrl", "option", "delete"], ["option", "f4"],
].map((c) => new Set(c));
const BLOCKED_TEXT = [/curl\s+[^|]*\|\s*(ba)?sh/i, /wget\s+[^|]*\|\s*(ba)?sh/i, /\bsudo\s+rm\s+-[rf]/i, /\brm\s+-rf\s+\/\s*$/i, /:\s*\(\)\s*\{\s*:\|:\s*&\s*\}/];

/** Both `+` and `-` separate keys: a driver accepts `ctrl-alt-delete`, so a split on `+` alone would let it through. */
export function keySet(keys: string): Set<string> {
  return new Set(keys.split(/\s*[+-]\s*/).map((k) => k.trim().toLowerCase()).filter(Boolean).map((k) => ALIASES[k] ?? k));
}
export const blockedKeys = (keys: string): boolean => { const have = keySet(keys); return BLOCKED_KEYS.some((b) => [...b].every((k) => have.has(k))); };
export const blockedText = (text: string): boolean => BLOCKED_TEXT.some((p) => p.test(text));

/** Windows of the operating system that only the person may answer. */
const SYSTEM_DIALOGS = ["securityagent", "usernotificationcenter", "universalaccessauthwarn", "coreautha", "consent.exe", "windows security", "polkit-gnome-authentication-agent-1"];

export interface GuardInput {
  mode: () => PermMode;
  /** Names the person's own navvied windows go by. */
  ownApps: readonly string[];
  humanHasControl: () => boolean;
  /** Most steps one task may take, and how many identical failures in a row end it. */
  maxSteps?: number;
  maxRepeats?: number;
}

export const WAIT_LIMIT_MS = 30_000;
export const clampWait = (ms: number): number => Math.max(0, Math.min(Number.isFinite(ms) ? ms : 0, WAIT_LIMIT_MS));

const same = (a: string, b: string) => { const x = a.trim().toLowerCase(), y = b.trim().toLowerCase(); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
const stop = (code: Refusal, next: string): Decision => ({ kind: "refuse", code, next });

export class Guard {
  private approved = new Set<string>();
  private target: string | undefined;
  private steps = 0;
  private lastFailed = ""; private repeats = 0;

  constructor(private i: GuardInput) {}

  /** The app the next input goes to when the call names none. */
  get sticky(): string | undefined { return this.target; }

  decide(call: Call): Decision {
    if (call.action === "type" && blockedText(call.text ?? "")) return stop("blocked_by_policy", "This text is never typed. Do something else.");
    if (call.action === "key" && blockedKeys(call.keys ?? "")) return stop("blocked_by_policy", "This shortcut is never pressed. Do something else.");
    if (this.i.humanHasControl()) return stop("human_has_control", "The person is using the screen. Wait, then capture again.");
    if (this.steps >= (this.i.maxSteps ?? 200)) return stop("blocked_by_policy", "The step limit of this task is reached. Tell the person what is done and what is left.");
    if (this.repeats >= (this.i.maxRepeats ?? 3)) return stop("blocked_by_policy", "The same step failed several times. Capture and try something different, or stop.");
    if (FREE.has(call.action)) return { kind: "allow" };

    const app = call.app?.trim() || this.target;
    if (!app) return stop("input_target_mismatch", "Capture an app first.");
    if (this.i.ownApps.some((o) => same(o, app)) || SYSTEM_DIALOGS.some((d) => app.toLowerCase().includes(d))) return stop("blocked_by_policy", "That window belongs to the person. Only they can answer it.");

    const input = call.action !== "capture";
    if (input && this.target && call.app && !same(this.target, call.app)) return stop("input_target_mismatch", `The last capture was of ${this.target}. Capture ${call.app} first.`);

    const mode = this.i.mode();
    if (mode === "plan") return stop("blocked_by_policy", "Plan mode only lists and waits.");
    if (mode === "bypass") return { kind: "allow" };
    const known = [...this.approved].some((a) => same(a, app));
    if (mode === "auto" && known) return { kind: "allow" };
    if (!input && known) return { kind: "allow" };
    return { kind: "ask", about: input ? "input" : "capture", app };
  }

  /** The person said yes to what `decide` asked: an app approved stays approved for the conversation. */
  approve(app: string): void { this.approved.add(app); }

  /** Called after a call that was allowed: counts the step, keeps the target, and watches for the same failure again and again. */
  settle(call: Call, delivered: boolean): void {
    if (FREE.has(call.action)) return;
    this.steps++;
    if (call.action === "capture" && delivered && call.app) this.target = call.app;
    const key = `${call.action}|${call.app ?? this.target ?? ""}|${call.text ?? ""}|${call.keys ?? ""}`;
    if (delivered) { this.repeats = 0; this.lastFailed = ""; } else if (key === this.lastFailed) this.repeats++; else { this.lastFailed = key; this.repeats = 1; }
  }

  /** A new conversation, or the person turned computer use off: nothing carries over. */
  reset(): void { this.approved.clear(); this.target = undefined; this.steps = 0; this.lastFailed = ""; this.repeats = 0; }
}
