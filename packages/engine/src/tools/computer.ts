import type { ScreenOutcome } from "@navvied/protocol";
import { untrusted } from "./untrusted.ts";
import type { ComputerCall, ComputerCode, ComputerResult, Tool, ToolContext } from "../types.ts";
import { clip, num, outputBudget, str } from "./util.ts";

/**
 * The screen of this computer, through the helper that owns it. The engine decides nothing about the operating system: it checks that a call
 * is complete, keeps the numbers of a capture honest, sends the step and relays the answer. Approvals, the hard blocks and the indicator are
 * the helper's, so a run without them cannot skip them.
 */
export const COMPUTER_TOOL = "computer";
const ACTIONS = ["capture", "click", "type", "key", "scroll", "list", "wait"] as const;
/** What plan mode allows: looking at what is there and waiting. A capture shows a person's screen, so it is not looking only. */
export const PLAN_COMPUTER_ACTIONS: ReadonlySet<string> = new Set(["list", "wait"]);
const INPUT: ReadonlySet<string> = new Set(["click", "type", "key", "scroll"]);

type Refusal = ComputerCode | "stale_target";
const NEXT: Record<Refusal, string> = {
  background_unavailable: "This app cannot be used without taking over the screen. Tell the person and stop.",
  background_occluded: "The window is hidden or minimized. Ask the person to show it, then capture again.",
  background_uipi_blocked: "This app runs with more rights than navvied and cannot be controlled. Tell the person and stop.",
  human_has_control: "The person is using the screen. Wait a little, then capture again.",
  input_target_mismatch: "The input would go to another app than the one captured. Capture the app you mean, then act.",
  permission_missing: "The person must allow it in the system settings. Tell them what is missing and stop.",
  blocked_by_policy: "This is not allowed. Do not look for a way round it: tell the person what you could not do.",
  stale_target: "Capture the app again, then use the new numbers.",
};
const UNVERIFIED = "The input was sent and could not be confirmed. Capture the app and look before you act again; do not send it twice.";
const UNCONFIRMED = "The last input could not be confirmed. Capture the app and look before you act again.";

/**
 * What this conversation knows of the screen: element numbers belong to one capture and die with the first input after it, and an input whose
 * outcome is not known is never followed by another until the screen has been looked at again.
 */
class Screen {
  app = "";
  fresh = false;
  unconfirmed = false;
  close(): void { /* nothing is held: the helper owns the screen */ }
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const line = (verdict: string, next?: string): string => (next ? `${verdict}\nNext: ${next}` : verdict);

function refuse(code: Refusal, next?: string, which?: string): string {
  return line(`refused: ${code}${which ? ` (${which})` : ""}`, (next ?? "").trim() || NEXT[code]);
}

/** What is wrong with a call before it is sent, in the words of a call the model can repeat. */
function incomplete(a: Record<string, unknown>, action: string): string | undefined {
  const has = (k: string): boolean => typeof a[k] === "number" || (typeof a[k] === "string" && (a[k] as string).trim() !== "");
  if (!(ACTIONS as readonly string[]).includes(action)) return `action is one of ${ACTIONS.join(", ")}`;
  if (action === "capture" && !has("app")) return "capture needs app, the application to look at";
  if (action === "click" && !has("target") && !(typeof a.x === "number" && typeof a.y === "number")) return "click needs target (a number from the capture), or x and y";
  if (action === "type" && typeof a.text !== "string") return "type needs text";
  if (action === "key" && !has("keys")) return "key needs keys, such as cmd+s";
  if (action === "scroll" && !has("target") && !has("app")) return "scroll needs target or app";
  return undefined;
}

/** The call the helper gets: only what the action uses, and never a picture for a model that cannot see. */
function callFor(a: Record<string, unknown>, action: (typeof ACTIONS)[number], seeing: boolean): { call: ComputerCall; mode?: "ax" | "som" | "vision" } {
  const call: ComputerCall = { action };
  const app = str(a.app).trim();
  if (app) call.app = app;
  if (typeof a.target === "number") call.target = Math.floor(a.target);
  if (typeof a.text === "string") call.text = a.text;
  if (str(a.keys).trim()) call.keys = str(a.keys).trim();
  if (typeof a.x === "number" && typeof a.y === "number") { call.x = Math.round(a.x); call.y = Math.round(a.y); }
  if (action !== "capture") return { call };
  const asked = str(a.mode);
  const mode = seeing ? (asked === "ax" || asked === "vision" ? asked : "som") : "ax";
  call.mode = mode;
  return { call, mode };
}

async function run(a: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const helper = ctx.computer;
  if (!helper) return "Error: computer use is not on. Ask the person to turn it on if they want you to use the screen.";
  const action = str(a.action);
  const bad = incomplete(a, action);
  if (bad) return `Error: ${bad}.`;
  const kind = action as (typeof ACTIONS)[number];
  const screen = ctx.keep ? ctx.keep("computer", () => new Screen()) : new Screen();
  const named = str(a.app).trim() || screen.app;
  /** What the step's card is told, next to the text the model reads. */
  const said = (text: string, verdict: ScreenOutcome["verdict"], more: Omit<ScreenOutcome, "verdict"> = {}): string => {
    ctx.report?.({ screen: { verdict, ...(named ? { app: named } : {}), ...more } });
    return text;
  };
  const stale = (next?: string): string => said(refuse("stale_target", next), "refused", { code: "stale_target", next: next ?? NEXT.stale_target });

  const input = INPUT.has(kind);
  const numbered = typeof a.target === "number";
  const other = numbered && str(a.app).trim() !== "" && screen.app !== "" && !same(screen.app, str(a.app));
  if (input && screen.unconfirmed) return stale(UNCONFIRMED);
  if (numbered && (!screen.fresh || other)) return stale();

  const { call, mode } = callFor(a, kind, ctx.vision === true);
  let r: ComputerResult;
  try { r = await helper.call(call, ctx.signal); }
  catch {
    // What an operating system said is not for the model; what is known is that nobody knows how it ended.
    if (ctx.signal.aborted) return "[interrupted]";
    if (!input) return "Error: the screen helper did not answer. Try once more; if it fails again, tell the person.";
    screen.fresh = false; screen.unconfirmed = true;
    return said(line("unverified", UNVERIFIED), "unverified", { next: UNVERIFIED });
  }
  if (ctx.signal.aborted) return "[interrupted]";

  const app = r.app?.trim() || named || undefined;
  const where = app ? { app } : {};
  if (input && r.verdict !== "refused") { screen.fresh = false; screen.unconfirmed = r.verdict === "unverified"; }
  if (r.verdict === "refused") {
    const code = (r.code && r.code in NEXT ? r.code : "blocked_by_policy") as Refusal;
    const which = code === "permission_missing" ? r.which : undefined;
    const next = r.next?.trim() || NEXT[code];
    ctx.report?.({ screen: { verdict: "refused", code, ...(which ? { which } : {}), ...where, next } });
    return refuse(code, next, which);
  }
  if (r.verdict === "unverified") { const next = r.next?.trim() || UNVERIFIED; ctx.report?.({ screen: { verdict: "unverified", ...where, next } }); return line("unverified", next); }
  ctx.report?.({ screen: { verdict: "delivered", ...where } });
  if (kind !== "capture" && kind !== "list") return "delivered";

  const tree = (r.tree ?? "").trim();
  const picture = kind === "capture" && mode !== "ax" && r.image && ctx.show;
  if (kind === "capture") { screen.app = str(a.app).trim(); screen.fresh = true; screen.unconfirmed = false; }
  if (picture) ctx.show!({ type: "image", mime: r.image!.mime, data: r.image!.data });
  if (tree || picture) ctx.keepOut?.(kind === "list" ? "[the list of apps was shown to the model only]" : `[a capture of ${str(a.app).trim()} was shown to the model only: ${tree ? `${tree.split("\n").length} lines` : "a picture"}]`);
  const wanted = str(a.mode);
  const reduced = kind === "capture" && wanted !== "" && wanted !== "ax" && mode === "ax" ? "\n(this model cannot see pictures, so only the numbered elements are given)" : "";
  return `delivered${reduced}${tree ? `\n${framedTree(tree, ctx)}` : kind === "capture" && !picture ? "\n(nothing was found in the app to number)" : ""}`;
}

/** What the screen showed is text from outside: it is framed here (the verdict and the next step are ours and stay outside the frame), and the turn is told it read outside text. */
function framedTree(tree: string, ctx: ToolContext): string {
  const text = clip(tree, outputBudget(ctx.window));
  ctx.outside?.(text);
  return untrusted("tool", text);
}

export const computer: Tool = {
  name: COMPUTER_TOOL,
  readOnly: false,
  inPlan: true,
  offeredWhen: ({ small, computer: on }) => on === true && !small,
  description: "Use an app on this computer. capture it first: its elements are numbered. Then click, type, key or scroll by number; numbers die after any input, so capture again. If the result is unverified or refused, do what Next says.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      app: { type: "string", description: "needed for capture" },
      target: { type: "number", description: "element number" },
      text: { type: "string" },
      keys: { type: "string", description: "such as cmd+s" },
      x: { type: "number" }, y: { type: "number" },
      mode: { type: "string", enum: ["ax", "som", "vision"] },
    },
    required: ["action"],
  },
  // A small model writes the number as text ("3").
  fixArgs: (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, (k === "target" || k === "x" || k === "y") && typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v])),
  title: (a) => `Computer: ${str(a.action)}${str(a.app) ? ` ${str(a.app)}` : ""}${a.target !== undefined ? ` ${num(a.target, 0)}` : ""}`,
  run,
};
