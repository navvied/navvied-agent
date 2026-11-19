import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const MAX_FILE = 20_000;
const MAX_TOTAL = 60_000;

/**
 * Expands `@path` mentions in a prompt: the text is kept, and the contents of each mentioned file inside `cwd` are appended
 * so the model has them without spending a tool call. Directories, binary files and paths outside `cwd` are left as written.
 */
export function expandMentions(text: string, cwd: string): string {
  const root = resolve(cwd);
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = match[1]!.replace(/[.,;:!?)]+$/, "");
    const path = resolve(root, rel);
    if (seen.has(path) || (path !== root && !path.startsWith(root + sep))) continue;
    seen.add(path);
    try {
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(0)) continue;
      const body = bytes.toString("utf8").slice(0, MAX_FILE);
      if (total + body.length > MAX_TOTAL) break;
      total += body.length;
      blocks.push(`[File ${rel}]\n${body}`);
    } catch { /* not a readable file: leave the mention as text */ }
  }
  return blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text;
}
