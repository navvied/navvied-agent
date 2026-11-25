import type { EngineEvent } from "@navvied/protocol";

type Hook = Extract<EngineEvent, { ev: "hook" }>;
type Browser = Extract<EngineEvent, { ev: "browser" }>;

/** What a step of the agent shows for a line of its own: a mark (`ok`, `bad` or `ask`), its words, what to put on the right, and a line under it. */
export interface StepLine { mark: "ok" | "bad" | "ask"; title: string; right?: string; under?: string }

const WHEN = (e: Hook): string => (e.tool ?? (e.event === "UserPromptSubmit" ? "your message" : "the end of the reply"));

/** A hook that decided something, in the words of the page: "Hook stopped Bash", "Hook after Write  ran the formatter". A hook that allowed it says nothing. */
export function hookLine(e: Hook): StepLine | undefined {
  if (e.decision === "allowed") return undefined;
  const where = WHEN(e);
  const said = e.reason ? e.reason.replace(/\s+/g, " ").trim() : "";
  if (e.decision === "blocked") return { mark: "bad", title: `Hook stopped ${where}`, ...(said ? { under: `The hook “${e.hook}” said: ${said}` } : {}) };
  if (e.decision === "asked") return { mark: "ask", title: `Hook asked about ${where}`, ...(said ? { under: said } : {}) };
  const title = e.event === "PostToolUse" ? `Hook after ${where}` : `Hook before ${where}`;
  const right = e.decision === "changed" ? said || "changed it" : said || "added text for the model";
  return { mark: "ok", title, right };
}

const REF = { "page-changed": "The page changed. navvied looks again.", gone: "The page changed. navvied looks again.", unknown: "That number is not on this page.", unnumbered: "Nothing is numbered yet. navvied looks first." } as const;

/** What the Browser tool saw besides its own answer: a page's question, a download, a file the page asks for, a number that no longer fits. Nothing for a state that needs no line. */
export function browserLine(e: Browser): StepLine | undefined {
  if (e.what === "dialog" && e.state === "answered") return { mark: "ok", title: "Answered a dialog", right: e.accepted ? "OK" : "Cancel" };
  if (e.what === "dialog" && e.state === "opened") return { mark: "ok", title: "A page asked a question", under: `The page asked: ${e.message ?? ""}`.trim() };
  if (e.what === "download" && e.state === "done") return { mark: "ok", title: "Saved a download", right: `${e.name ?? ""}${e.bytes !== undefined ? `, ${size(e.bytes)}` : ""}`, ...(e.path ? { under: e.path } : {}) };
  if (e.what === "download" && e.state === "failed") return { mark: "bad", title: "Could not save a download", ...(e.note ? { under: e.note } : {}) };
  if (e.what === "ref" && e.state === "expired") return { mark: "bad", title: "Could not click on the page", under: REF[e.why as keyof typeof REF] ?? REF["page-changed"] };
  return undefined;
}

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
