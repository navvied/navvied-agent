import { createHash } from "node:crypto";
import { noWindowMatches } from "../src/tools/computer.ts";
import type { ComputerCall, ComputerCode, ComputerHelper, ComputerResult } from "../src/types.ts";

/**
 * A screen that is a script, for tests and offline tasks: the apps, what each shows and what a step on it does. It stands in for the helper
 * that drives a real screen, so the engine's side (the numbers, the verdicts, what is kept) is tried without an operating system.
 */
export interface FakeRule {
  /** The screen the app shows after the step. */
  to?: string;
  /** `unverified`: the input was sent and cannot be proven to have landed (the screen still changes, as it may have). */
  verdict?: "unverified";
  next?: string;
  refuse?: { code: ComputerCode; which?: string; next?: string };
}
export interface FakeScreen {
  /** The numbered lines the helper answers a capture with. `{code:N}` is a value made from the run's secret. */
  tree: string[];
  /** What a step does here, by `click 2`, `type`, `key`, `scroll`: a screen to go to, or a rule. A step with no rule is delivered and changes nothing. */
  on?: Record<string, string | FakeRule>;
}
export interface FakeApp {
  start: string;
  screens: Record<string, FakeScreen>;
  /** A rule for every capture of the app (a missing permission, a policy). */
  capture?: FakeRule;
}
export type FakeWorld = Record<string, FakeApp>;

const PICTURE = { mime: "image/png", data: "iVBORw0KGgo=" };

export const codeOf = (secret: string, n: string): string => createHash("sha1").update(`${secret}screen${n}`).digest("hex").slice(0, 10);

export class FakeComputer implements ComputerHelper {
  /** Every call the engine sent, in order, as it was sent. */
  readonly calls: ComputerCall[] = [];
  readonly #at = new Map<string, string>();
  #app = "";

  constructor(private readonly world: FakeWorld, private readonly secret = "fixture-secret") {}

  #open(): string[] {
    return Object.keys(this.world).map((n, i) => `${i + 1} app "${n}"`);
  }

  async call(c: ComputerCall): Promise<ComputerResult> {
    this.calls.push(structuredClone(c));
    if (c.action === "wait") return { verdict: "delivered" };
    if (c.action === "list" && c.app) return this.world[c.app] ? { verdict: "delivered", tree: `1 window "${c.app}"` } : noWindowMatches(c.app, this.#open());
    if (c.action === "list") return { verdict: "delivered", tree: this.#open().join("\n") };
    if (c.action === "capture" && c.app && !this.world[c.app]) return noWindowMatches(c.app, this.#open());
    const name = c.app && this.world[c.app] ? c.app : c.app ? undefined : this.#app;
    const app = name ? this.world[name] : undefined;
    if (!name || !app) return { verdict: "refused", code: "input_target_mismatch", ...(c.app ? { app: c.app } : {}), next: c.app ? `${c.app} is not running. Capture another app.` : "Capture an app first." };
    const screen = (): FakeScreen => app.screens[this.#at.get(name) ?? app.start]!;
    if (c.action === "capture") {
      if (app.capture) return this.#answer(name, app.capture);
      this.#app = name;
      const tree = screen().tree.join("\n").replace(/\{code:(\w+)\}/g, (_, n: string) => codeOf(this.secret, n));
      return { verdict: "delivered", app: name, tree, ...(c.mode && c.mode !== "ax" ? { image: PICTURE } : {}) };
    }
    const rule = this.#ruleFor(screen(), c);
    return this.#answer(name, typeof rule === "string" ? { to: rule } : rule ?? {});
  }

  /** The most specific rule of the screen for a step: `right click 3`, `double click 3`, `drag 2>5` (or `drag 10,20>30,40`), `scroll 3 up`, each also with `+shift` for the keys held; then the plain `click 3`, then the action. */
  #ruleFor(screen: FakeScreen, c: ComputerCall): string | FakeRule | undefined {
    const place = (t?: number, x?: number, y?: number): string => (t !== undefined ? `${t}` : x !== undefined ? `${x},${y}` : "");
    const what = c.action === "click" ? `${c.count === 2 ? "double " : c.button ? `${c.button} ` : ""}click ${place(c.target, c.x, c.y)}`
      : c.action === "drag" ? `drag ${place(c.target, c.x, c.y)}>${place(c.to, c.to_x, c.to_y)}`
      : c.action === "scroll" ? `scroll ${c.target ?? ""} ${c.direction ?? ""}` : c.action;
    const held = c.keys && c.action !== "key" ? `+${c.keys.toLowerCase()}` : "";
    const plain = c.action === "click" || c.action === "scroll" ? `${c.action} ${c.target ?? ""}` : c.action;
    for (const k of [`${what.trim()}${held}`, what.trim(), `${plain.trim()}${held}`, plain.trim(), c.action]) if (screen.on?.[k] !== undefined) return screen.on[k];
    return undefined;
  }

  #answer(name: string, rule: FakeRule): ComputerResult {
    if (rule.refuse) return { verdict: "refused", code: rule.refuse.code, app: name, ...(rule.refuse.which ? { which: rule.refuse.which } : {}), ...(rule.refuse.next ? { next: rule.refuse.next } : {}) };
    if (rule.to) this.#at.set(name, rule.to);
    return rule.verdict === "unverified" ? { verdict: "unverified", app: name, ...(rule.next ? { next: rule.next } : {}) } : { verdict: "delivered", app: name };
  }
}
