/**
 * The small part of YAML that a skill's front matter uses, with no dependency: `key: value`, quoted strings, block text
 * (`>` folded and `|` literal, with `-` and `+`), plain values that go on over indented lines, `[a, b]` lists, `- item` lists,
 * and true/false. Anything else is read as plain text, never as an error: a skill with odd front matter still loads.
 */
export type YamlValue = string | boolean | string[];

const unquote = (v: string): string => {
  const m = /^(["'])([\s\S]*)\1$/.exec(v);
  if (!m) return v;
  return m[1] === '"' ? m[2]!.replace(/\\(["\\nt])/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c)) : m[2]!.replace(/''/g, "'");
};

const scalar = (v: string): YamlValue => {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean);
  return unquote(t.replace(/\s+#.*$/, ""));
};

const indent = (line: string): number => line.length - line.trimStart().length;

/** Folds block lines: `>` joins lines with spaces (a blank line is a paragraph break), `|` keeps them. */
function block(lines: string[], style: string): string {
  const step = Math.min(...lines.filter((l) => l.trim()).map(indent), Infinity);
  const cut = lines.map((l) => (l.trim() ? l.slice(step === Infinity ? 0 : step) : ""));
  let text = style.startsWith("|") ? cut.join("\n") : cut.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ").replace(/\n\n/g, "\n");
  text = text.replace(/\s+$/, "");
  return style.includes("+") ? `${text}\n` : text;
}

export function parseYaml(source: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w.-]*):(?:\s+(.*)|\s*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase(), rest = (kv[2] ?? "").trim();
    const body: string[] = [];
    while (i + 1 < lines.length && (!lines[i + 1]!.trim() || indent(lines[i + 1]!) > 0 || /^-\s/.test(lines[i + 1]!))) body.push(lines[++i]!);
    while (body.length && !body[body.length - 1]!.trim()) body.pop();
    if (/^[>|][+-]?\d*$/.test(rest)) out[key] = block(body, rest);
    else if (rest === "" && body.some((l) => /^\s*-\s/.test(l))) out[key] = body.flatMap((l) => { const m = /^\s*-\s+(.*)$/.exec(l); return m ? [unquote(m[1]!.trim())] : []; });
    else if (rest === "" && body.length) out[key] = body.filter((l) => l.trim()).map((l) => l.trim()).join(" ");
    else out[key] = body.length && typeof scalar(rest) === "string" ? [rest, ...body.map((l) => l.trim())].join(" ").replace(/\s+/g, " ") : scalar(rest);
  }
  return out;
}
