import type { PermMode, SessionKind } from "@navvied/protocol";

export interface PromptInfo {
  cwd: string;
  platform: string;
  date: string;
  persona?: string;
  instructions?: string;
  /** Commands in the background that ended since the model last heard of them, one line each. */
  finished?: string[];
  /** The notes being saved from what the person just said: the model is told, so that it neither says it cannot save nor saves them again. */
  noted?: string[];
  /** Tools that exist and are not offered in this request: named, without their definitions. */
  also?: string[];
  /** What to say about the program itself, for a request that asks. */
  reference?: string;
  /** The names of the tools offered in this request, so the prompt names only those. */
  tools?: string[];
  /** The skills the model can load, already written out. */
  skills?: string;
  /** A model with a small context window, usually one running locally: it gets a shorter, more direct prompt. */
  small?: boolean;
  /** `chat`: a conversation with a scratch folder (default `agent`). */
  kind?: SessionKind;
  /** A chat that may run commands (it runs in a sandbox). */
  sandboxed?: boolean;
}

const PLAN_NOTE =
  "PLAN MODE: you may only read and research (Read, Glob, Grep, WebFetch, TodoWrite). Do NOT change anything. " +
  "When you know exactly what to do, call ExitPlanMode with a concrete step-by-step plan for the user to approve.";

const REMEMBER_NOTE = "Remember: save lasting facts about the person and project, not task progress.";

const notedNow = (info: PromptInfo): string => (info.noted?.length ? `Notes being saved from the person's message: ${info.noted.join("; ")}. Do not call Remember for them.` : "");

const remembers = (info: PromptInfo): boolean => info.tools?.includes("Remember") === true || info.also?.includes("Remember") === true;

const ASK_TOOL = "AskUserQuestion";
/** The one rule about choosing tools: no tool is offered or withheld by the words of a request, so the model is told to read what is wanted, and to ask when that is unclear. */
const asks = (info: PromptInfo): boolean => info.tools === undefined || info.tools.includes(ASK_TOOL);
const PICK = `Pick tools by the goal, not the words. Clear request: do it, no offers. Must guess a value? Ask one question (${ASK_TOOL}).`;

const CODE_ONLY = "A change to code changes code: leave comments and strings unless asked.";

const SMALL_RULES = [
  "Chat in plain text. Use tools only to read or change files or run commands.",
  "Read before changing a file; make the smallest change that works; check it. Say what you did.",
  "Use Bash for commands, not for answers. Never invent file names.",
].join("\n");

/** What a chat is told. It is a conversation first; the scratch folder and the tools are there for when they help. */
function chatPrompt(info: PromptInfo): string {
  const run = info.sandboxed ? " and run commands (Bash) there, for example to analyse data or to try code" : "";
  return [
    info.persona?.trim(),
    `You are a helpful assistant in a conversation. Date: ${info.date}.`,
    info.small
      ? "Answer directly and in plain words. Use a tool only when it really helps."
      : "Be direct, warm and accurate. Answer in plain language, with structure only when it helps. If you are not sure, say so rather than guess.",
    `You have a scratch folder: ${info.cwd}. You can read what the person gives you there and write files for them there (documents, data, code)${run}. You cannot see or change anything else on their computer, and you have no project. Search or fetch the web (WebSearch, WebFetch) when the answer depends on something recent or outside your knowledge, and say where it came from.`,
    asks(info) ? PICK : "",
    "Use tools to act; never claim you did something you did not do. Tell the person what file you made and where it is.",
    info.skills,
  ].filter(Boolean).join("\n\n");
}

export function systemPrompt(info: PromptInfo, mode: PermMode): string {
  if (info.kind === "chat") return chatPrompt(info);
  if (info.small) {
    return [
      info.persona?.trim(),
      `You are a coding assistant working in ${info.cwd} on ${info.platform}.${info.tools?.some((t) => t === "WebSearch" || t === "WebFetch") ? ` Date: ${info.date}.` : ""}`,
      SMALL_RULES,
      asks(info) ? PICK : "",
      remembers(info) ? REMEMBER_NOTE : "",
      notedNow(info),
      mode === "plan" ? PLAN_NOTE : "",
      info.also?.length ? `Also available, by name: ${info.also.join(", ")}.` : "",
      info.reference,
      info.finished?.length ? info.finished.join("\n") : "",
      info.skills,
      info.instructions ? `Standing instructions from the user. Follow them:\n\n${info.instructions}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return [
    info.persona?.trim(),
    `Working directory: ${info.cwd}. Platform: ${info.platform}. Date: ${info.date}.`,
    `Work carefully: read before you edit, make the smallest correct change, run the tests or the program to check it, and say what you verified. Be concise. Never claim to have done what you did not. Prefer Read, Glob and Grep to the shell for looking at code.${info.tools?.includes("TodoWrite") ? " Use TodoWrite for work in several steps or when a list is asked for, then do the steps." : ""} If a tool call is denied, do not retry it: ask what they prefer.`,
    CODE_ONLY,
    asks(info) ? PICK : "",
    mode === "plan" ? PLAN_NOTE : "",
    remembers(info) ? REMEMBER_NOTE : "",
    notedNow(info),
    info.also?.length ? `Also available, by name: ${info.also.join(", ")}.` : "",
    info.reference,
    info.finished?.length ? info.finished.join("\n") : "",
    info.skills,
    info.instructions ? `The user keeps standing instructions for this work. Follow them unless the current request says otherwise.\n\n${info.instructions}` : "",
  ].filter(Boolean).join("\n\n");
}
