import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Suggest, Suggestion } from "./tui/menu.ts";

const MAX_HITS = 40;

/** Files and folders under `cwd` that start with `partial` (a path relative to `cwd`). Directories end with `/`. */
export function pathMatches(cwd: string, partial: string): string[] {
  const dir = partial.includes("/") ? dirname(partial) : ".";
  const prefix = partial.includes("/") ? partial.slice(dir.length + 1) : partial;
  let names: string[];
  try { names = readdirSync(resolve(cwd, dir)); } catch { return []; }
  return names
    .filter((n) => n.startsWith(prefix) && !(prefix === "" && n.startsWith(".")) && n !== ".git" && n !== "node_modules")
    .sort()
    .slice(0, MAX_HITS)
    .map((n) => {
      const rel = dir === "." ? n : join(dir, n).replace(/\\/g, "/");
      try { return statSync(resolve(cwd, rel)).isDirectory() ? `${rel}/` : rel; } catch { return rel; }
    });
}

export interface CommandInfo {
  name: string;
  /** What the command takes, shown after its name: `<name>`. */
  args?: string;
  desc: string;
}

/** Suggestions while typing: `/command` at the start of the line, `@path` for the word being typed. */
export function makeSuggest(commands: readonly CommandInfo[], cwd: string): Suggest {
  return (text, cursor) => {
    const slash = /^\/(\S*)$/.exec(text);
    if (slash) {
      const items = commands.filter((c) => c.name.startsWith(slash[1]!)).map((c): Suggestion => ({
        label: `/${c.name}${c.args ? ` ${c.args}` : ""}`,
        hint: c.desc,
        insert: c.args ? `/${c.name} ` : `/${c.name}`,
        run: !c.args,
      }));
      return items.length ? { from: 0, items } : undefined;
    }
    const upTo = text.slice(0, cursor);
    const at = /(?:^|\s)@(\S*)$/.exec(upTo);
    if (!at) return undefined;
    const from = upTo.length - at[1]!.length - 1;
    const items = pathMatches(cwd, at[1]!).map((p): Suggestion => ({ label: `@${p}`, insert: p.endsWith("/") ? `@${p}` : `@${p} `, run: false }));
    return items.length ? { from, items } : undefined;
  };
}
