import type { Paths } from "./rules.ts";
import { EXEC_PRIMITIVE } from "./shell-scan.ts";
import { away, secret } from "./taint-place.ts";

/**
 * What a program's text does that a page would want after it was read: send something over the network, change a place outside the project, read a
 * file that keeps secrets. Read as text, in any language, from the calls each one has for it; this is not a parser, so what it cannot see (a name
 * built while the program runs) is not claimed. The same three questions the shell path asks of a command.
 */
export type CodeKind = "send" | "write" | "secret";

const HTTP = /\b(?:requests\.(?:get|post|put|patch|delete|head|request|Session)|urllib\d?|http\.client|httpx|aiohttp|urlopen|urlretrieve|pycurl|fetch\s*\(|XMLHttpRequest|axios|node-fetch|node:https?|(?:require\s*\(|from)\s*["']https?["']|WebSocket|Net::HTTP|open-uri|URI\.open|LWP|HTTP::Tiny|curl_exec|file_get_contents\s*\(\s*["']https?|Invoke-(?:WebRequest|RestMethod)|iwr|irm|WebClient)/;
const LOW = /\b(?:socket\.(?:socket|create_connection)|import\s+socket|smtplib|ftplib|telnetlib|paramiko|node:(?:net|tls|dgram)|(?:require\s*\(|from)\s*["'](?:net|tls|dgram)["']|net\.(?:connect|Socket|createConnection)|IO::Socket|fsockopen|Bun\.connect|Deno\.connect)/;
const TOOLS = /["'`](?:[^"'`]*[\s/])?(?:curl|wget|nc|ncat|netcat|scp|sftp|socat)(?:\s[^"'`]*)?["'`]/;
const LOOPBACK = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|\[::1\]|0\.0\.0\.0)(?:[:/?#]|$)/i;

/** What a program reads data from: with it, a call to this computer's own address is no longer only a look at its own service. */
const SOURCE = /\b(?:environ|process\.env|Deno\.env|getenv|readFile\w*|read_text|read_bytes|open\s*\()|ENV\[/;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const literals = (text: string): string[] => [...text.matchAll(LITERAL)].map((m) => m[2]!);

const WRITES = /\b(open|fopen|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyfile|copy2|copyFileSync|cpSync|copy|move|rename|renameSync|rmtree|remove|unlink|unlinkSync|rmSync|makedirs|mkdirSync|symlink|file_put_contents|File\.write|File\.open|IO\.write)\s*\(/g;
const PATH_OBJECT = /\bPath\s*\(\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1\s*\)\s*\.\s*(?:write_text|write_bytes|open|touch|mkdir|unlink|rename)/g;
const HOME = /\b(?:homedir|Path\.home|expanduser|environ|process\.env|Deno\.env|ENV\[)|\$\{?HOME\b|~\//;
const TWO_PLACES = /^(copy|copy2|copyfile|copyFileSync|cpSync|move|rename|renameSync|symlink)$/;
const OPENS = /^open|^fopen|^File\.open$/;
const MODE = /^[rbtU]*[wax+][bt+]*$/;

/** The text between the brackets that open at `from`, up to a limit: strings and nested brackets are skipped over. */
function inside(code: string, from: number): string {
  let depth = 1, quote = "";
  for (let i = from; i < Math.min(code.length, from + 600); i++) {
    const c = code[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(from, i);
  }
  return code.slice(from, from + 600);
}

function writesAway(code: string, cwd: string, p: Paths): boolean {
  for (const m of code.matchAll(PATH_OBJECT)) if (away(m[2]!, cwd, p)) return true;
  for (const m of code.matchAll(WRITES)) {
    const args = inside(code, m.index! + m[0].length);
    const lits = literals(args);
    if (OPENS.test(m[1]!) && !lits.slice(1).some((l) => MODE.test(l)) && !/\bmode\s*=\s*["'][^"']*[wax+]/.test(args)) continue;
    if (HOME.test(args) || (TWO_PLACES.test(m[1]!) ? lits : lits.slice(0, 1)).some((l) => away(l, cwd, p))) return true;
  }
  return false;
}

/** The first of the three that a program's text does, or nothing. */
export function codeRisk(code: string, cwd: string, p: Paths): CodeKind | undefined {
  const urls = code.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  const web = urls.length > 0 && urls.every((u) => LOOPBACK.test(u)) && !SOURCE.test(code);
  if ((!web && HTTP.test(code)) || LOW.test(code) || (EXEC_PRIMITIVE.test(code) && TOOLS.test(code))) return "send";
  if (literals(code).some((l) => l.length < 300 && secret(l))) return "secret";
  if (writesAway(code, cwd, p)) return "write";
  return undefined;
}
