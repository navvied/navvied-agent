/** What a tool call is, in words a person who has never used a terminal understands. */
export interface Step {
  /** While it runs: "Reading checkout.ts". */
  running: string;
  /** Once it is done: "Read checkout.ts". */
  done: string;
}

type Input = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, max: number): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** A path as the person knows it: relative to the folder they work in when it is inside it. */
export function shortPath(path: string, cwd: string): string {
  const slash = (p: string): string => p.replace(/\\/g, "/");
  const p = slash(path), base = slash(cwd).replace(/\/+$/, "");
  if (base && p.startsWith(`${base}/`)) return p.slice(base.length + 1);
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+)\//.exec(p);
  return home ? `~/${p.slice(home[0].length)}` : p;
}

const pageOf = (url: string): string => { try { const u = new URL(url); return `${u.host}${u.pathname === "/" ? "" : u.pathname}`; } catch { return url; } };

const BROWSER: Record<string, [string, string]> = {
  read: ["Reading the page", "Read the page"], click: ["Clicking on the page", "Clicked on the page"], type: ["Typing on the page", "Typed on the page"], choose: ["Choosing on the page", "Chose on the page"],
  press: ["Pressing a key", "Pressed a key"], scroll: ["Scrolling the page", "Scrolled the page"], back: ["Going back", "Went back"], screenshot: ["Taking a screenshot", "Took a screenshot"],
  dialog: ["Answering a dialog", "Answered a dialog"], upload: ["Filling in a form", "Filled in a form"], wait: ["Waiting for the page", "Waited for the page"],
};

export function describeStep(name: string, input: unknown, cwd: string, app = ""): Step {
  const a = (typeof input === "object" && input !== null ? input : {}) as Input;
  const file = shortPath(str(a.file_path), cwd);
  switch (name) {
    case "Read": return { running: `Reading ${file}`, done: `Read ${file}` };
    case "Write": return { running: `Writing ${file}`, done: `Wrote ${file}` };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { running: `Changing ${file}`, done: `Changed ${file}` };
    case "Bash": {
      // A description the agent wrote ("Run the tests") is already a phrase of its own; only a bare command needs a verb.
      const said = oneLine(str(a.description), 70);
      if (said) return { running: said, done: said };
      const c = oneLine(str(a.command), 70);
      return { running: `Running ${c}`, done: `Ran ${c}` };
    }
    case "Glob": return { running: `Looking for ${oneLine(str(a.pattern), 50)}`, done: `Looked for ${oneLine(str(a.pattern), 50)}` };
    case "Grep": return { running: `Searching for ${oneLine(str(a.pattern), 50)}`, done: `Searched for ${oneLine(str(a.pattern), 50)}` };
    case "WebFetch": { let host = str(a.url); try { host = new URL(host).host; } catch { /* shown as typed */ } return { running: `Opening ${host}`, done: `Opened ${host}` }; }
    case "WebSearch": return { running: `Searching the web for ${oneLine(str(a.query), 50)}`, done: `Searched the web for ${oneLine(str(a.query), 50)}` };
    case "TodoWrite": return { running: "Updating the task list", done: "Updated the task list" };
    case "BashOutput": return { running: `Checking ${str(a.job_id) || "the background job"}`, done: `Checked ${str(a.job_id) || "the background job"}` };
    case "BashInput": return { running: `Typing to ${str(a.job_id) || "the program"}`, done: `Typed to ${str(a.job_id) || "the program"}` };
    case "KillShell": return { running: `Stopping ${str(a.job_id) || "the background job"}`, done: `Stopped ${str(a.job_id) || "the background job"}` };
    case "Agent": case "Task": { const what = oneLine(str(a.description) || str(a.prompt), 60); return { running: `Asking a helper${what ? `: ${what}` : ""}`, done: `Asked a helper${what ? `: ${what}` : ""}` }; }
    case "CronList": return { running: "Checking the schedule", done: "Checked the schedule" };
    case "CronCreate": return { running: "Scheduling a task", done: "Scheduled a task" };
    case "CronDelete": return { running: "Removing a scheduled task", done: "Removed a scheduled task" };
    case "NotebookEdit": return { running: "Editing a notebook", done: "Edited a notebook" };
    case "mcp__find": return { running: "Searching the tools of the connected programs", done: "Searched the tools of the connected programs" };
    case "MakeImage": return { running: "Making a picture", done: "Made a picture" };
    case "MakeVideo": return { running: "Making a short video", done: "Made a short video" };
    case "Speak": return { running: "Reading the text aloud", done: "Read the text aloud" };
    case "Transcribe": return { running: "Turning speech into text", done: "Turned speech into text" };
    case "LookAt": return { running: "Looking at the picture", done: "Looked at the picture" };
    case "Watch": return { running: "Looking through the video", done: "Looked through the video" };
    case "Browser": {
      const action = str(a.action);
      if (action === "open" || action === "new") { const page = pageOf(str(a.url)); return { running: `Opening ${page}`, done: `Opened ${page}` }; }
      const known = BROWSER[action];
      return known ? { running: known[0], done: known[1] } : { running: "Using the browser", done: "Used the browser" };
    }
    case "Computer": {
      const where = str(a.app) || app, at = where ? ` in ${where}` : "";
      switch (str(a.action)) {
        case "capture": return { running: "Looking at the screen", done: "Looked at the screen" };
        case "click": return { running: `Clicking${at}`, done: `Clicked${at}` };
        case "type": return { running: `Typing${at}`, done: `Typed${at}` };
        case "key": return { running: `Pressing keys${at}`, done: `Pressed keys${at}` };
        case "scroll": return { running: `Scrolling${at}`, done: `Scrolled${at}` };
        case "list": return { running: "Looking at the open apps", done: "Looked at the open apps" };
        case "wait": return { running: "Waiting", done: "Waited" };
        default: return { running: "Using the computer", done: "Used the computer" };
      }
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) { const what = `${words(mcp[1]!.replace(/^[a-z]+_ai_/i, ""))}: ${words(mcp[2]!).toLowerCase()}`; return { running: `Using ${what}`, done: `Used ${what}` }; }
      return { running: `Using ${name}`, done: `Used ${name}` };
    }
  }
}

/** `search_threads` as "Search threads". */
const words = (s: string): string => { const t = s.replace(/[_-]+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

/** The same step when it did not work: "Could not read a.ts". */
export function describeFailure(name: string, input: unknown, cwd: string): string {
  const a = (typeof input === "object" && input !== null ? input : {}) as Input;
  const file = shortPath(str(a.file_path), cwd);
  switch (name) {
    case "Read": return `Could not read ${file}`;
    case "Write": return `Could not write ${file}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Could not change ${file}`;
    case "Bash": return str(a.description) ? `${oneLine(str(a.description), 70)} failed` : `The command failed: ${oneLine(str(a.command), 70)}`;
    case "Glob": case "Grep": return "The search did not work";
    case "WebFetch": case "WebSearch": return "Could not reach the web";
    case "MakeImage": return "Could not make the picture";
    case "MakeVideo": return "Could not make the video";
    case "Speak": return "Could not read the text aloud";
    case "Transcribe": return "Could not turn the speech into text";
    case "LookAt": return "Could not look at the picture";
    case "Watch": return "Could not look through the video";
    case "Browser": return str(a.action) === "open" || str(a.action) === "new" ? `Could not open ${pageOf(str(a.url))}` : str(a.action) === "screenshot" ? "Could not take a screenshot" : "Could not use the browser";
    case "Computer": return "Could not use the screen";
    default: return `Could not use ${name}`;
  }
}

/** A short result to show beside a finished step, or nothing. */
export function stepTail(name: string, input: unknown, output: string): string {
  const a = (typeof input === "object" && input !== null ? input : {}) as Input;
  const first = output.split("\n")[0] ?? "";
  switch (name) {
    case "Read": { const n = output.split("\n").length; return `${n} line${n === 1 ? "" : "s"}`; }
    case "Edit": {
      const { added, removed } = countChanges(str(a.old_string), str(a.new_string));
      return `${added} line${added === 1 ? "" : "s"} added, ${removed} removed`;
    }
    case "Bash": {
      const passed = /\b(\d+)\s+(?:tests?\s+)?(?:pass(?:ed|ing)?)\b/i.exec(output);
      if (passed) return `${passed[1]} passed`;
      const { exitCode } = parseBashOutput(output);
      return exitCode !== undefined && exitCode !== 0 ? `failed, exit ${exitCode}` : "";
    }
    case "Glob": { const n = output.split("\n").filter((l) => l.trim() && !l.startsWith("[")).length; return n ? `${n} file${n === 1 ? "" : "s"}` : ""; }
    case "Grep": return /^No matches/.test(first) ? "no matches" : "";
    case "mcp__find": { const n = /^(\d+) found/.exec(first)?.[1]; return `“${oneLine(str(a.query), 40)}”, ${n ?? "no"} found`; }
    default: return "";
  }
}

export function countChanges(before: string, after: string): { added: number; removed: number } {
  const b = before ? before.split("\n") : [], a = after ? after.split("\n") : [];
  return { added: a.length, removed: b.length };
}

export interface DiffRow { kind: "add" | "del" | "more"; line: number; text: string }

/** The lines an edit takes away and puts in, numbered from where the change starts. Long changes are cut, and say so. */
export function diffRows(before: string, after: string, start: number, limit = 12): DiffRow[] {
  const rows: DiffRow[] = [];
  before.split("\n").forEach((text, i) => { if (before) rows.push({ kind: "del", line: start + i, text }); });
  after.split("\n").forEach((text, i) => { if (after) rows.push({ kind: "add", line: start + i, text }); });
  if (rows.length <= limit) return rows;
  const shown = rows.slice(0, limit);
  return [...shown, { kind: "more", line: 0, text: `${rows.length - limit} more line${rows.length - limit === 1 ? "" : "s"}` }];
}

/** The line a change begins at, from what the Edit tool reported ("at line 41"). */
export const startLine = (output: string): number => Number(/ at line (\d+)/.exec(output)?.[1] ?? 1);

/** Whether a tool call failed, from what it returned. */
export const failed = (output: string): boolean => output.startsWith("Error:");

/** A line the Bash tool adds about itself, not the command's own output: where it now runs, or a background job's status. */
/** (`now in` and `stays in` are how conversations kept before the note said who wrote it read.) */
const NOTE_LINE = /^\[(navvied: .+|now in .+|stays in .+|still running as job\d+ after .+|job\d+ finished[^\]]*)\]$/;
/** The line a Bash call ends with, when it says how it went: the old form (`[exit N]`, every code) or the new one (`[exit N: reason]`, only when N is not 0). */
const EXIT_LINE = /^\[exit (\d+)(?::\s*(.+))?\]$/;

export interface BashOutcome {
  /** What the command itself printed: neither the exit line nor navvied's own notes, and empty for the literal "(no output)" too. */
  lines: string[];
  /** The folder and background-job notes navvied adds, oldest first. */
  notes: string[];
  /** The exit code, when the output said one: the old form always does, the new one only on failure. */
  exitCode?: number;
}

/**
 * Bash output has always carried a line of its own at the end (how it went); it can now also carry a note about where the command
 * left the working folder, or about a background job. This takes those apart from what the command itself printed.
 */
export function parseBashOutput(output: string): BashOutcome {
  const trimmed = output.replace(/\s+$/, "");
  const all = trimmed === "" ? [] : trimmed.split("\n");
  const notes: string[] = [];
  let exitCode: number | undefined;
  for (;;) {
    const last = all.at(-1)?.trim();
    if (last === undefined) break;
    const exit = EXIT_LINE.exec(last);
    // The reason the engine gave (grep's "no matches" is not a failure) is kept as a quiet note; the bare "[exit N]" of a plain failure is not.
    if (exit) { exitCode = Number(exit[1]); const popped = all.pop()!.trim(); if (exit[2]) notes.unshift(popped); continue; }
    if (NOTE_LINE.test(last)) { notes.unshift(all.pop()!.trim()); continue; }
    break;
  }
  if (all.length === 1 && all[0]!.trim() === "(no output)") all.pop();
  return { lines: all, notes, exitCode };
}

/** Whether Bash output says the command failed, in either the old or the new form. */
export const bashFailed = (output: string): boolean => { const e = parseBashOutput(output).exitCode; return e !== undefined && e !== 0; };
