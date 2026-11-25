/** A piece of a shell script: `background` when the shell would have started it with a closing `&` (the `&` is not part of `text`). */
export interface Piece { text: string; background: boolean }

const OPEN = new Set(["if", "for", "while", "until", "case", "select"]);
const CLOSE = new Set(["fi", "done", "esac"]);
/** Words after which the next word starts a command. */
const LEAD = new Set(["then", "do", "else", "elif", "time", "!"]);

/**
 * Cuts a script after every `&` that sends a whole statement to the background, so each of those can be started as a job of its own. A script that `wait`s for what it started manages it itself and ends with it, so it is left whole. Only a statement of the top level counts: an `&` in
 * quotes, a comment, a heredoc, `$(...)`, backticks, parentheses, or inside if/for/while/case is the shell's own business, and `&&`, `&>`, `>&`, `<&`, `|&` are not it at all.
 */
export function splitBackground(script: string): Piece[] {
  const pieces: Piece[] = [];
  const heredocs: { tag: string; strip: boolean }[] = [];
  let from = 0, stmt = 0, depth = 0, nest = 0, command = true, cont = false, waits = false, i = 0;
  const n = script.length;
  const skipQuoted = (q: string): void => {
    for (i++; i < n && script[i] !== q; i++) if (q === '"' && script[i] === "\\") i++;
  };
  while (i < n) {
    const c = script[i]!;
    if (!/\s/.test(c) && c !== "&" && c !== "|") cont = false;
    if (c === "\\") { i += 2; command = false; continue; }
    if (c === "'" || c === '"' || c === "`") { skipQuoted(c); i++; command = false; continue; }
    if (c === "$" && script[i + 1] === "(") { nest++; i += 2; continue; }
    if (c === "(") { nest++; i++; command = true; continue; }
    if (c === ")") { nest = Math.max(0, nest - 1); i++; command = false; continue; }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(script[i - 1]!))) { while (i < n && script[i] !== "\n") i++; continue; }
    if (c === "\n") {
      i++;
      for (const h of heredocs.splice(0)) {
        while (i < n) {
          let end = script.indexOf("\n", i);
          if (end < 0) end = n;
          const line = script.slice(i, end);
          i = Math.min(n, end + 1);
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.tag) break;
        }
      }
      command = true;
      if (!cont && nest === 0 && depth === 0) stmt = i;
      continue;
    }
    if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([\w.-]+))/.exec(script.slice(i));
      if (m) { heredocs.push({ tag: m[2] ?? m[3] ?? m[4] ?? "", strip: m[1] === "-" }); i += m[0].length; command = false; continue; }
    }
    if (c === "&") {
      const prev = script[i - 1], next = script[i + 1];
      if (next === "&") { i += 2; command = true; cont = true; continue; }
      if (next === ">" || prev === ">" || prev === "<" || prev === "|") { i++; continue; }
      if (nest === 0 && depth === 0 && /^[ \t]*(?:#.*)?(?:\n|$)|^[ \t]*[^\s;&|)]/.test(script.slice(i + 1))) {
        pieces.push({ text: script.slice(from, stmt), background: false }, { text: script.slice(stmt, i), background: true });
        from = stmt = i + 1;
      }
      i++; command = true; continue;
    }
    if (c === ";" || c === "|") { i++; command = true; cont = c === "|"; if (c === ";" && nest === 0 && depth === 0) stmt = i; continue; }
    if (c === " " || c === "\t") { i++; continue; }
    const word = /^[^\s;&|()<>'"`\\$#]+/.exec(script.slice(i))?.[0];
    if (!word) { i++; command = false; continue; }
    if (command) {
      if (word === "wait") waits = true;
      if (OPEN.has(word)) depth++;
      else if (CLOSE.has(word)) depth = Math.max(0, depth - 1);
      else if (word === "{") depth++;
      else if (word === "}") depth = Math.max(0, depth - 1);
    }
    command = command && LEAD.has(word);
    i += word.length;
  }
  if (waits) return [{ text: script, background: false }];
  if (from < n) pieces.push({ text: script.slice(from), background: false });
  return pieces.filter((p) => p.background || p.text.trim());
}
