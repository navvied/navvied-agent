import type { SessionKind } from "@navvied/protocol";
import type { Tool } from "./types.ts";

/**
 * What a kind of conversation may use. One engine, two profiles:
 *  - `agent` works on a project: every tool, in the folder it was started in, with the person's permission modes.
 *  - `chat` works in a scratch folder of its own and nowhere else: it can search and read the web, read and write files in that
 *    folder (what the person gave it, what it makes for them), remember things, and, only where the program itself runs in a sandbox,
 *    run commands. It has no helpers, no skills, no browser, no task list and no project: it asks the person nothing, because it cannot
 *    reach anything of theirs.
 */
const CHAT_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Remember"]);
const CHAT_SANDBOX_TOOLS = new Set(["Bash", "BashOutput", "BashInput", "KillShell"]);

export interface ProfileFacts {
  /** Whether the program runs inside a sandbox (a hosted session): only then may a chat run commands. */
  sandboxed: boolean;
}

/** The tools of a kind of conversation, out of all the tools there are. */
export function profileTools(kind: SessionKind, all: readonly Tool[], facts: ProfileFacts): Tool[] {
  if (kind === "agent") return [...all];
  return all.filter((t) => CHAT_TOOLS.has(t.name) || (facts.sandboxed && CHAT_SANDBOX_TOOLS.has(t.name)));
}

/** Whether the tools of this kind are held to one folder. */
export const isConfined = (kind: SessionKind): boolean => kind === "chat";
