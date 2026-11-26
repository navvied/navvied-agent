import { readFileSync } from "node:fs";

const SLOW_SECONDS = 3;
const MOST_SLOW = 15;
export const MOST_NOTE_BYTES = 4096;
export const MOST_NOTES = 8;
const MOST_NAME = 130;
const MOST_REASON = 110;
const MOST_DETAIL = 240;
const SAYS_NOTHING = /^(?:[-+] (?:Expected|Received)\s+[-+] \d+|at .*|[[\]{}(),]*)$/;
const ROOM_FOR_THE_REST = 60;

const unxml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, t: string) => {
  if (t[0] === "#") return String.fromCodePoint(t[1] === "x" || t[1] === "X" ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10));
  return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[t.toLowerCase()]!;
});
const data = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const property = (s: string): string => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

interface Case { file: string; suite: string; name: string; seconds: number; failure?: string }

function attribute(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unxml(m[1]!) : "";
}

export function cases(xml: string): Case[] {
  const out: Case[] = [];
  const open = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const failure = /<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(m[3] ?? "");
    out.push({
      file: attribute(m[1]!, "file"), suite: attribute(m[1]!, "classname"), name: attribute(m[1]!, "name"), seconds: Number(attribute(m[1]!, "time")) || 0,
      ...(failure ? { failure: attribute(failure[2]!, "message") || attribute(failure[2]!, "type") || "failed" } : {}),
    });
  }
  return out;
}

const label = (c: Case): string => (c.name === "(unnamed)" ? `a hook of "${c.suite || "the file"}"` : [c.suite, c.name].filter(Boolean).join(" > "));
const place = (c: Case): string => (c.file ? `file=${property(c.file)},` : "");

const shortPath = (file: string): string => file.replaceAll("\\", "/").replace(/^.*?\/packages\//, "").replace(/^packages\//, "packages/");

const detailOf = (failure: string): string => failure.split("\n").slice(1).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => !SAYS_NOTHING.test(line)).join(" ").slice(0, MOST_DETAIL);

function grouped(failed: readonly Case[], detailed: boolean): { head: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const c of failed) {
    const head = [shortPath(c.file), c.failure!.split("\n")[0]!.slice(0, MOST_REASON), detailed ? detailOf(c.failure!) : ""].filter(Boolean).join(" :: ");
    groups.set(head, [...(groups.get(head) ?? []), label(c).slice(0, MOST_NAME)]);
  }
  return [...groups].map(([head, names]) => ({ head, names }));
}

interface Note { lines: string[]; bytes: number }

function split(failed: readonly Case[], detailed: boolean): { notes: string[]; left: number } {
  const notes: Note[] = [{ lines: [], bytes: 0 }];
  const room = (at: number): number => MOST_NOTE_BYTES - (at === MOST_NOTES - 1 ? ROOM_FOR_THE_REST : 0);
  let named = 0;
  for (const { head, names } of grouped(failed, detailed)) {
    let open = false;
    for (const name of names) {
      let note = notes.at(-1)!;
      let piece = open ? ` | ${name}` : `${note.lines.length ? "\n" : ""}${head} :: ${name}`;
      if (note.bytes + Buffer.byteLength(piece) > room(notes.length - 1)) {
        if (notes.length === MOST_NOTES) return { notes: notes.map((n) => n.lines.join("")), left: failed.length - named };
        notes.push((note = { lines: [], bytes: 0 }));
        piece = `${head} :: ${name}`;
      }
      note.lines.push(piece);
      note.bytes += Buffer.byteLength(piece);
      open = true;
      named++;
    }
  }
  return { notes: notes.map((n) => n.lines.join("")), left: 0 };
}

function allFailed(failed: readonly Case[]): string[] {
  const detailed = split(failed, true);
  const { notes, left } = detailed.left ? split(failed, false) : detailed;
  return notes.map((body, at) => {
    const title = `${failed.length} failed tests${notes.length > 1 ? ` (${at + 1} of ${notes.length})` : ""}`;
    const rest = left && at === notes.length - 1 ? `\nand ${left} more that did not fit` : "";
    return `::error title=${property(title)}::${data(body + rest)}`;
  });
}

export function annotations(xml: string): string[] {
  const all = cases(xml);
  const failed = all.filter((c) => c.failure !== undefined);
  const slow = all.filter((c) => c.failure === undefined && c.seconds >= SLOW_SECONDS).sort((a, b) => b.seconds - a.seconds).slice(0, MOST_SLOW);
  return [...(failed.length ? allFailed(failed) : []), ...slow.map((c) => `::warning ${place(c)}title=${property(`slow: ${label(c)}`)}::took ${c.seconds.toFixed(1)} s`)];
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: ci-annotate.ts report.xml"); process.exit(2); }
  let xml: string;
  try { xml = readFileSync(file, "utf8"); } catch { console.log("::warning title=no test report::the test runner wrote no report"); process.exit(0); }
  for (const line of annotations(xml)) console.log(line);
}
