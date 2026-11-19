const FENCE = /^```[a-z]*\s*([\s\S]*?)\s*```$/i;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function tryParse(text: string): Record<string, unknown> | undefined {
  try { return asObject(JSON.parse(text)); } catch { return undefined; }
}

/** Raw line breaks and tabs inside a string are illegal in JSON; models write them anyway. */
function escapeControlsInStrings(text: string): string {
  let out = "", inString = false, escaped = false;
  for (const ch of text) {
    if (inString && !escaped && ch === "\n") out += "\\n";
    else if (inString && !escaped && ch === "\r") out += "\\r";
    else if (inString && !escaped && ch === "\t") out += "\\t";
    else out += ch;
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = inString;
    else if (ch === '"') inString = !inString;
  }
  return out;
}

/** Closes brackets and braces the model forgot, and a string it left open. */
function closeOpen(text: string): string {
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = inString; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if ((ch === "}" || ch === "]") && stack.at(-1) === ch) stack.pop();
  }
  return `${text}${inString ? '"' : ""}${stack.reverse().join("")}`;
}

/**
 * The arguments of a tool call as an object. Strict JSON is accepted as it is; when it is not, the usual slips of a
 * small model are put right: a code fence around it, text before or after it, single quotes, bare keys, trailing commas,
 * Python's True/False/None, raw line breaks inside strings, and brackets that were never closed.
 */
export function parseLenient(text: string): Record<string, unknown> | undefined {
  const raw = text.trim();
  if (!raw) return {};
  const strict = tryParse(raw);
  if (strict) return strict;

  let t = FENCE.exec(raw)?.[1] ?? raw;
  const start = t.indexOf("{");
  if (start < 0) return undefined;
  const end = t.lastIndexOf("}");
  t = end > start ? t.slice(start, end + 1) : t.slice(start);

  const fixes: ((s: string) => string)[] = [
    (s) => s.replace(/,\s*([}\]])/g, "$1"),
    (s) => (s.includes('"') ? s : s.replace(/'/g, '"')),
    (s) => s.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":'),
    (s) => s.replace(/:\s*True\b/g, ": true").replace(/:\s*False\b/g, ": false").replace(/:\s*None\b/g, ": null"),
    escapeControlsInStrings,
    closeOpen,
    (s) => s.replace(/,\s*([}\]])/g, "$1"),
  ];
  let current = t;
  for (const fix of fixes) {
    current = fix(current);
    const parsed = tryParse(current);
    if (parsed) return parsed;
  }
  return undefined;
}
