import { dirname, isAbsolute, relative, resolve } from "node:path";

/** What a person agrees to when they say "do not ask again": a kind of command, a folder, a website, or one tool. */
export interface Scope {
  key: string;
  /** In words, to finish "do not ask again for …". */
  phrase: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The first word of a command, past variables set in front of it and `sudo`; nothing when there is none. */
function commandWord(command: string): string {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "sudo") continue;
    return word.replace(/^.*[\\/]/, "");
  }
  return "";
}

export function approvalScope(tool: string, args: Record<string, unknown>, cwd: string): Scope {
  if (tool === "Bash") { const word = commandWord(text(args.command)); return { key: `bash:${word}`, phrase: word ? `${word} commands` : "commands" }; }
  if (tool === "Write" || tool === "Edit") {
    const file = text(args.file_path);
    const full = isAbsolute(file) ? file : resolve(cwd, file);
    const inside = file ? relative(resolve(cwd), full).replace(/\\/g, "/") : "";
    // A file outside the project is never covered by a permission given for the project.
    if (!file || inside.startsWith("..") || isAbsolute(inside)) return { key: `outside:${dirname(full)}`, phrase: `changes in ${dirname(full)}` };
    return inside.includes("/") ? { key: `file:${inside.split("/")[0]}`, phrase: `changes in ${inside.split("/")[0]}/` } : { key: "file:.", phrase: "changes in the project folder" };
  }
  if (tool === "WebFetch" || (tool === "Browser" && text(args.url))) {
    try { const host = new URL(text(args.url)).host; return { key: `web:${host}`, phrase: `pages on ${host}` }; } catch { /* fall through */ }
  }
  return { key: `tool:${tool}`, phrase: tool };
}
