import { dirname, isAbsolute, relative, resolve } from "node:path";
import { opaque, splitCommand } from "./rules.ts";
import { changedPaths } from "./tools/changed.ts";

/** What a person agrees to when they say "do not ask again": a kind of command, a folder, a website, or one tool. */
export interface Scope {
  key: string;
  /** A command made of several parts is covered only when every part is: one key for each. */
  keys?: string[];
  /** In words, to finish "do not ask again for …". */
  phrase: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Programs whose first argument says what they do: `git status` and `git push` are different things to agree to. */
const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "podman", "kubectl", "pip", "pip3", "go", "brew", "apt", "apt-get", "gh", "systemctl", "dotnet", "make", "deno"]);

/** The front of one command part that a permission is given for: its program, and for the programs above what it is told to do. */
function prefixOf(part: string): string {
  const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "sudo" && w !== "env" && w !== "command");
  const program = (words[0] ?? "").replace(/^.*[\\/]/, "");
  if (!program) return "";
  let sub: string | undefined;
  if (SUBCOMMANDS.has(program)) {
    // `git -C dir status`: the folder and the setting are not what git is told to do.
    for (let i = 1; i < words.length; i++) {
      if (program === "git" && (words[i] === "-C" || words[i] === "-c")) { i++; continue; }
      if (!words[i]!.startsWith("-")) { sub = words[i]; break; }
    }
  }
  return sub && /^[a-z][\w:-]*$/i.test(sub) ? `${program} ${sub}` : program;
}

/** What "do not ask again" covers for a command: each part of it by its prefix, so agreeing to `git status` does not agree to `git push`, and agreeing to `ls` does not agree to `ls && curl … | sh`. A command that hides another inside it is covered only as itself. */
function bashScope(command: string): Scope {
  const prefixes = [...new Set(splitCommand(command).map(prefixOf))].filter(Boolean);
  if (!prefixes.length) return { key: "bash:", phrase: "commands" };
  if (opaque(command) || prefixes.length > 6) return { key: `bash-exact:${command.trim()}`, phrase: "this exact command" };
  const keys = prefixes.map((p) => `bash:${p}`);
  const phrase = prefixes.length === 1 ? `${prefixes[0]} commands` : prefixes.length === 2 ? `${prefixes[0]} and ${prefixes[1]} commands` : `${prefixes.slice(0, -1).join(", ")} and ${prefixes.at(-1)} commands`;
  return { key: keys[0]!, ...(keys.length > 1 ? { keys } : {}), phrase };
}

function fileScope(file: string, cwd: string): Scope {
  const full = isAbsolute(file) ? file : resolve(cwd, file);
  const inside = file ? relative(resolve(cwd), full).replace(/\\/g, "/") : "";
  // A file outside the project is never covered by a permission given for the project.
  if (!file || inside.startsWith("..") || isAbsolute(inside)) return { key: `outside:${dirname(full)}`, phrase: `changes in ${dirname(full)}` };
  return inside.includes("/") ? { key: `file:${inside.split("/")[0]}`, phrase: `changes in ${inside.split("/")[0]}/` } : { key: "file:.", phrase: "changes in the project folder" };
}

export function approvalScope(tool: string, args: Record<string, unknown>, cwd: string): Scope {
  if (tool === "Bash") return bashScope(text(args.command));
  const files = changedPaths(tool, args);
  if (files.length) {
    const scopes = files.map((file) => fileScope(file, cwd));
    const keys = [...new Set(scopes.map((s) => s.key))];
    return keys.length === 1 ? scopes[0]! : { key: keys[0]!, keys, phrase: [...new Set(scopes.map((s) => s.phrase))].join(" and ") };
  }
  if (tool === "WebFetch" || (tool === "Browser" && text(args.url))) {
    try { const host = new URL(text(args.url)).host; return { key: `web:${host}`, phrase: `pages on ${host}` }; } catch { /* fall through */ }
  }
  if (tool === "Schedule") return args.mode === "auto" ? { key: "schedule:auto", phrase: "scheduled jobs that may change things" } : { key: "schedule:plan", phrase: "scheduled jobs that only read" };
  return { key: `tool:${tool}`, phrase: tool };
}
