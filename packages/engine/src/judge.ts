import type { PermMode } from "@navvied/protocol";
import { approvalScope, type Scope } from "./approval-scope.ts";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { needsApproval } from "./permissions.ts";
import { riskOf, type Risk } from "./risk.ts";
import { afterOutside, type Outside, type Turn } from "./taint.ts";
import { reachOutside } from "./reach.ts";
import { hardBlock, nativePaths, type Paths, type Rules } from "./rules.ts";
import { expandHome, homeFrom } from "./where.ts";
import { readPaths } from "./tools/changed.ts";
import { COMPUTER_TOOL, PLAN_COMPUTER_ACTIONS } from "./tools/computer.ts";
import type { Tool } from "./types.ts";

const within = (root: string, path: string, cwd: string): boolean => { const r = relative(resolve(cwd, root), resolve(cwd, path)); return r !== ".." && !r.startsWith("../") && !r.startsWith("..\\") && !isAbsolute(r); };

export interface JudgeInput {
  mode: PermMode;
  tool: Pick<Tool, "name" | "readOnly" | "askAfterOutside">;
  args: Record<string, unknown>;
  cwd: string;
  /** What `~` is and how paths are read (default: this computer, with the home of this process's environment). */
  paths?: Paths | undefined;
  rules?: Rules | undefined;
  /** What the person said "do not ask again" to in this conversation. */
  allowed: ReadonlySet<string>;
  /** Whether an address came from the person, a search or a page that was read. */
  knownUrl: (url: unknown) => boolean;
  /** Folders outside the project that the program itself keeps things in (attachments, notes, long output): reading is free there. When this is not given, a look outside the project is not asked about. */
  readable?: readonly string[] | undefined;
  /** What this turn has read from outside. Once it has read something, a few actions are asked about even in Auto (see `afterOutside`). */
  outside?: (Pick<Outside, "seen" | "copied"> & Turn["outside"]) | undefined;
  /** The values this conversation knows as secrets: an address that carries one is asked about after outside text was read. */
  secrets?: (() => readonly string[]) | undefined;
  /** The folders of project skills the person has not accepted: the skill is held back, and so are its files, so reading one is not a way around it. */
  held?: (() => readonly { name: string; dir: string }[]) | undefined;
}

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
  const p = i.paths ?? nativePaths;
  const forbidden = hardBlock(tool.name, args, cwd, p);
  if (forbidden) return { kind: "stop", message: `Blocked: ${forbidden}. navvied never does this.` };
  const heldSkill = i.held && readPaths(tool.name, args).length ? i.held().find((h) => readPaths(tool.name, args).some((p) => within(h.dir, p, cwd))) : undefined;
  if (heldSkill) return { kind: "stop", message: `Blocked: ${heldSkill.name} is a skill of this project that the person has not accepted, so it is held back, and its files are not read either. Say what you wanted from it.` };
  const verdict = i.rules?.check(tool.name, args) ?? { kind: "none" as const };
  if (verdict.kind === "deny") return { kind: "stop", message: `Blocked by the permission rule ${verdict.rule}. Do not try again; tell the user what you wanted to do.` };
  // The screen is the host's: it asks (once per app, or per input), keeps its hard blocks and knows the mode, so the engine adds no question of its own. Plan mode is the one thing it says itself: only looking at what is there, and waiting. A rule that says "ask" still asks.
  if (tool.name === COMPUTER_TOOL) {
    if (mode === "plan") return PLAN_COMPUTER_ACTIONS.has(String(args.action)) ? { kind: "go" } : { kind: "stop", message: "Plan mode only allows list and wait on the screen. Do not capture or send input; say what you would do." };
    if (verdict.kind !== "ask") return { kind: "go" };
  }
  // What cannot be undone is asked about in every mode but Bypass, and a rule that allows "git" does not allow it: what is allowed is a kind of thing.
  // What an instruction in outside text would need is asked about too, unless the person's own allow rule names the call; Bypass is the person's word, Plan changes nothing.
  const tainted = i.outside?.seen && mode !== "plan" && mode !== "bypass" && verdict.kind !== "allow" ? afterOutside(tool, args, cwd, p, { outside: i.outside, secrets: i.secrets?.() }) : undefined;
  const risk = (tool.readOnly || mode === "plan" || mode === "bypass" ? undefined : riskOf(tool.name, args, cwd, p)) ?? tainted;
  const riskAsked = risk !== undefined && !i.allowed.has(risk.key);
  // An address nobody gave is the way out for what an injected page asks for: asked about, or refused where nobody is asked.
  const strange = tool.name === "WebFetch" && verdict.kind !== "allow" && mode !== "auto" && mode !== "bypass" && !i.knownUrl(args.url);
  if (strange && mode === "edits") return { kind: "stop", message: `Not fetched: ${String(args.url)} was not in the request, in a search result or in a page that was read. Search for it: WebSearch {"query": "…"}, or ask the person for the address.` };
  // Anything outside the project (scratch space aside) is asked about in the modes that ask, whatever the tool: a change, a search through a whole place, and, where the program says
  // which folders are its own, a plain look at a file. Bypass is the person's word and Plan changes nothing. A rule that allows the call is the person's word too.
  const asks = mode === "ask" || mode === "edits" || mode === "auto";
  const reach = reachOutside(tool.name, args, cwd, p, i.readable ?? []);
  const outside = verdict.kind === "allow" ? [] : [...(asks ? [...reach.writes, ...reach.searches] : []), ...(i.readable && (mode === "ask" || mode === "edits") ? reach.opens : [])];
  const mustAsk = verdict.kind === "ask" ? mode !== "plan" : riskAsked || strange || (needsApproval(mode, tool, args) && verdict.kind !== "allow") || outside.length > 0;
  if (!mustAsk) return { kind: "go" };
  const looked = outside.length && !reach.writes.length ? resolve(cwd, expandHome(outside[0]!, p.home ?? homeFrom())) : undefined;
  const at = looked && tool.name === "Read" ? dirname(looked) : looked;
  const scope = riskAsked ? { key: risk!.key, phrase: risk!.phrase } : at ? { key: `read-outside:${at}`, phrase: `reads in ${at}` } : approvalScope(tool.name, args, cwd, p.home);
  const always = verdict.kind === "ask" || riskAsked;
  if (!always && (scope.keys ?? [scope.key]).every((k) => i.allowed.has(k))) return { kind: "go" };
  return { kind: "ask", scope, ...(risk ? { risk } : {}), strange: strange && !riskAsked, ...(i.outside?.copied(args) ? { copied: true as const } : {}) };
}
