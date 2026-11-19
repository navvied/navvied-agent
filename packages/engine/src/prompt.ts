import type { PermMode, SessionKind } from "@navvied/protocol";

/** A request that asks about the program itself (its commands, modes, files, tools): only then is the reference about it put in the prompt. */
export const asksAboutProgram = (text: string): boolean => /(^|\s)\/(model|mode|clear|compact|memory|resume|help|checkpoints|restore|login|logout|tools|plugins|steps|output|theme|remote|devices|schedule|exit|web|search|folder|copy|move|import|effort|go|artifacts)(?![\w./-])|\bnavvied\b|\b(how (do|can|to)|what (can|do) you|which|where)\b.*\b(you|mode|model|command|tool|memory|checkpoint|undo|restore|remote|schedule|theme|login|plugin|shortcut|setting|folder|conversation|resume|compact|clear)\b|\b(your|the) (tools|commands|modes|settings)\b|\bwho are you\b|\bwhat are you\b|\bshortcut|\bshift\+tab\b/i.test(text);

export interface PromptInfo {
  cwd: string;
  platform: string;
  date: string;
  persona?: string;
  instructions?: string;
  /** Commands in the background that ended since the model last heard of them, one line each. */
  finished?: string[];
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

const SMALL_RULES = [
  "Answer questions and chat in plain text, directly. Use a tool only when you must read or change files or run a command.",
  "Read a file before you change it. Make the smallest change that works, then check it. Say only what you really did.",
  "Use Bash for commands, never to print your answer. Do not make up file names or web addresses.",
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
    "Use tools to act; never claim you did something you did not do. Tell the person what file you made and where it is.",
    info.skills,
  ].filter(Boolean).join("\n\n");
}

export function systemPrompt(info: PromptInfo, mode: PermMode): string {
  if (info.kind === "chat") return chatPrompt(info);
  if (info.small) {
    return [
      info.persona?.trim(),
      `You are a coding assistant working in ${info.cwd} on ${info.platform}.`,
      SMALL_RULES,
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
    `Work carefully: read before you edit, make the smallest correct change, run the tests or the program to check it, and say what you verified. Be concise. Never claim to have done what you did not. Prefer Read, Glob and Grep to the shell for looking at code.${info.tools?.includes("TodoWrite") ? " Use TodoWrite for work in several steps." : ""} If a tool call is denied, do not retry it: ask what they prefer.`,
    mode === "plan" ? PLAN_NOTE : "",
    info.also?.length ? `Also available, by name: ${info.also.join(", ")}.` : "",
    info.reference,
    info.finished?.length ? info.finished.join("\n") : "",
    info.skills,
    info.instructions ? `The user keeps standing instructions for this work. Follow them unless the current request says otherwise.\n\n${info.instructions}` : "",
  ].filter(Boolean).join("\n\n");
}
