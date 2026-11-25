
export interface Brain {
  /** How a person would name it in a sentence: the model's id, or the program or plan it comes from. */
  label: string;
  /** The names of the tools the engine itself offers. Empty when a program brings its own. */
  tools?: string[];
  /** The tools come from the program the agent runs in, not from navvied. */
  program?: boolean;
  /** The tools navvied's own engine has, which a program's brain can say it is not using. */
  ownTools?: string[];
  /** A small model gets a shorter text: it has little room, and long instructions confuse it. */
  small?: boolean;
  /** A chat: a conversation with a scratch folder, not a project. */
  chat?: boolean;
}

const MAX_NOTES = 8_000;

const IDENTITY = (brain: Brain): string => [
  brain.chat ? "You are navvied, an assistant. You talk with the user, and you can search the web and make files for them in a folder of your own." : "You are navvied, a coding agent. You work in the user's own folder, and the user sees everything you do.",
  `The model you think with is ${brain.label}. That model is your brain, not your name.`,
  "If you are asked who or what you are, say you are navvied and say which brain you are using. Never present yourself as another assistant or program.",
  "Say what you really did and what you did not check.",
].join(" ");

/** What the brain knows about the program it runs in. The slash commands are the person's to type: they are not named here, so the prompt does not change when one is added. */
export function aboutNavvied(brain: Brain): string {
  if (brain.small) return "In the app the user chooses the model from a menu, can undo your changes from the snapshots saved before each message, and changes the mode with Shift+Tab.";
  return [
    "How navvied works, in case the user asks:",
    "- The user talks to you in a terminal app or a web page, and chooses the model from a menu there.",
    "- Shift+Tab changes the mode: ask (you wait for approval before changing files or running commands), auto (you act freely), plan (you only read, then present a plan).",
    "- Every message saves a snapshot of the project first, so the user can undo your changes.",
    "- The user can keep standing instructions in a file called NAVVIED.md, in the project folder or in their own navvied folder.",
    ...(brain.tools?.length ? [`- Your tools: ${brain.tools.join(", ")}.`] : []),
    ...(brain.program ? [
      "- Your tools come from the program you run in, not from navvied. If you are asked what tools you have, list them and say that they belong to that program.",
      `- navvied is the app the user is looking at. It runs you through that program. For other models (on this computer, hosted, or with an API key) navvied uses its own engine, which has its own tools${brain.ownTools?.length ? `: ${brain.ownTools.join(", ")}` : ""}. This conversation does not use them.`,
    ] : []),
    "When the user asks how to do something in navvied, answer from this.",
  ].join("\n");
}

/**
 * Who the agent is, in a few words, for the engine's own models. What it knows about the program (the commands, the modes) is
 * `aboutNavvied`, sent only with a request that asks; the tools are in the request already and are not listed again.
 */
export function leanSoul(brain: Brain): string {
  if (brain.chat) return IDENTITY(brain);
  return `You are navvied, a coding agent in the user's own folder; the user sees everything you do. Your model is ${brain.label}: that is your brain, not your name. If asked who you are, say navvied and which brain. Say what you did and what you did not check.`;
}

export const referenceFor = (brain: Brain): string | undefined => (brain.chat ? undefined : aboutNavvied({ ...brain, tools: [] }));

/** The same self-knowledge and identity for every brain; the model is only what the agent thinks with. */
export function soulFor(brain: Brain, notes?: string): string {
  if (brain.chat) return IDENTITY(brain);
  const base = `${IDENTITY(brain)}\n\n${aboutNavvied(brain)}`;
  if (!notes?.trim()) return base;
  const kept = notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES)}\n… [notes shortened]` : notes;
  return `${base}\n\nThe user keeps standing instructions for this work. Follow them unless the current request says otherwise.\n\n${kept}`;
}
