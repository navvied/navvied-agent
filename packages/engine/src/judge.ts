import type { PermMode } from "@navvied/protocol";
import { approvalScope, type Scope } from "./approval-scope.ts";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { needsApproval } from "./permissions.ts";
import { riskOf, type Risk } from "./risk.ts";
import { afterOutside, type Outside } from "./taint.ts";
import { hardBlock, type Rules } from "./rules.ts";
import { readPaths } from "./tools/changed.ts";
import { COMPUTER_TOOL, PLAN_COMPUTER_ACTIONS } from "./tools/computer.ts";
import type { Tool } from "./types.ts";

export interface JudgeInput {
  mode: PermMode;
  tool: Pick<Tool, "name" | "readOnly" | "askAfterOutside">;
  args: Record<string, unknown>;
  cwd: string;
  rules?: Rules | undefined;
  /** What the person said "do not ask again" to in this conversation. */
  allowed: ReadonlySet<string>;
  /** Whether an address came from the person, a search or a page that was read. */
  knownUrl: (url: unknown) => boolean;
  /** Folders outside the project that the program itself keeps things in (attachments, notes, long output): reading is free there. When this is not given, a look outside the project is not asked about. */
  readable?: readonly string[] | undefined;
  /** What this turn has read from outside. Once it has read something, a few actions are asked about even in Auto (see `afterOutside`). */
  outside?: Pick<Outside, "seen" | "copied"> | undefined;
}

const within = (root: string, path: string, cwd: string): boolean => { const r = relative(resolve(cwd, root), resolve(cwd, path)); return r !== ".." && !r.startsWith("../") && !r.startsWith("..\\") && !isAbsolute(r); };

/** What is to be done with a tool call: stopped for a reason (said to the model), let through, or asked about. */
export type Judgement =
  | { kind: "stop"; message: string }
  | { kind: "go" }
  | {
      kind: "ask";
      scope: Scope;
      /** The reason it cannot be undone, when that is why it is asked. */
      risk?: Risk;
      /** An address nobody gave: asked about, so that a page cannot send the agent anywhere. */
      strange: boolean;
      /** The call holds a long piece of text that was read from outside, word for word. */
      copied?: true;
    };

/**
 * The one place that decides what a mode means for a tool call, for every engine: what is never done and what a rule denies is stopped; what cannot
 * be undone is asked about in every mode but Plan and Bypass; an address nobody gave is asked about unless the mode asks for nothing; the rest
 * is asked about as the mode says, unless the person has already agreed to that kind of thing. The built-in engine and a program's engine both
 * ask this, so a mode is the same thing everywhere.
 */
export function judge(i: JudgeInput): Judgement {
  const { mode, tool, args, cwd } = i;
  const forbidden = hardBlock(tool.name, args, cwd);
  if (forbidden) return { kind: "stop", message: `Blocked: ${forbidden}. navvied never does this.` };
  const verdict = i.rules?.check(tool.name, args) ?? { kind: "none" as const };
  if (verdict.kind === "deny") return { kind: "stop", message: `Blocked by the permission rule ${verdict.rule}. Do not try again; tell the user what you wanted to do.` };
  // The screen is the host's: it asks (once per app, or per input), keeps its hard blocks and knows the mode, so the engine adds no question of its own. Plan mode is the one thing it says itself: only looking at what is there, and waiting. A rule that says "ask" still asks.
  if (tool.name === COMPUTER_TOOL) {
    if (mode === "plan") return PLAN_COMPUTER_ACTIONS.has(String(args.action)) ? { kind: "go" } : { kind: "stop", message: "Plan mode only allows list and wait on the screen. Do not capture or send input; say what you would do." };
    if (verdict.kind !== "ask") return { kind: "go" };
  }
  // What cannot be undone is asked about in every mode but Bypass, and a rule that allows "git" does not allow it: what is allowed is a kind of thing.
  // What an instruction in outside text would need is asked about too, unless the person's own allow rule names the call; Bypass is the person's word, Plan changes nothing.
  const tainted = i.outside?.seen && mode !== "plan" && mode !== "bypass" && verdict.kind !== "allow" ? afterOutside(tool, args, cwd) : undefined;
  const risk = (tool.readOnly || mode === "plan" || mode === "bypass" ? undefined : riskOf(tool.name, args, cwd)) ?? tainted;
  const riskAsked = risk !== undefined && !i.allowed.has(risk.key);
  // An address nobody gave is the way out for what an injected page asks for: asked about, or refused where nobody is asked.
  const strange = tool.name === "WebFetch" && verdict.kind !== "allow" && mode !== "auto" && mode !== "bypass" && !i.knownUrl(args.url);
  if (strange && mode === "edits") return { kind: "stop", message: `Not fetched: ${String(args.url)} was not in the request, in a search result or in a page that was read. Search for it: WebSearch {"query": "…"}, or ask the person for the address.` };
  // Looking at a place outside the project is asked about in the modes that ask, unless a rule allows it: a program of the person's has no business there unasked.
  const outside = i.readable && (mode === "ask" || mode === "edits") ? readPaths(tool.name, args).filter((p) => !within(cwd, p, cwd) && !i.readable!.some((r) => within(r, p, cwd))) : [];
  const mustAsk = verdict.kind === "ask" ? mode !== "plan" : riskAsked || strange || (needsApproval(mode, tool, args) && verdict.kind !== "allow") || (outside.length > 0 && verdict.kind !== "allow");
  if (!mustAsk) return { kind: "go" };
  const looked = outside.length ? (tool.name === "Read" ? dirname(resolve(cwd, outside[0]!)) : resolve(cwd, outside[0]!)) : undefined;
  const scope = riskAsked ? { key: risk!.key, phrase: risk!.phrase } : looked ? { key: `read-outside:${looked}`, phrase: `reads in ${looked}` } : approvalScope(tool.name, args, cwd);
  const always = verdict.kind === "ask" || riskAsked;
  if (!always && (scope.keys ?? [scope.key]).every((k) => i.allowed.has(k))) return { kind: "go" };
  return { kind: "ask", scope, ...(risk ? { risk } : {}), strange: strange && !riskAsked, ...(i.outside?.copied(args) ? { copied: true as const } : {}) };
}
