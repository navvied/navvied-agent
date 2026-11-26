import { readFileSync } from "node:fs";

const SLOW_SECONDS = 3;
const MOST_SLOW = 15;
export const MOST_MESSAGE = 60_000;
const MOST_NAME = 200;
const MOST_REASON = 120;
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

const failureLine = (c: Case): string => [c.file, `${label(c)} (${c.seconds.toFixed(1)} s)`.slice(0, MOST_NAME), c.failure!.split("\n")[0]!.slice(0, MOST_REASON)].filter(Boolean).join(" :: ");

function allFailed(failed: readonly Case[]): string {
  const head = `::error title=${property(`${failed.length} failed tests`)}::`;
  let list = "";
  for (const [at, one] of failed.entries()) {
    const next = `${at ? "%0A" : ""}${data(failureLine(one))}`;
    if (head.length + list.length + next.length > MOST_MESSAGE - ROOM_FOR_THE_REST) return `${head}${list}%0Aand ${failed.length - at} more that did not fit`;
    list += next;
  }
  return head + list;
}

export function annotations(xml: string): string[] {
  const all = cases(xml);
  const failed = all.filter((c) => c.failure !== undefined);
  const slow = all.filter((c) => c.failure === undefined && c.seconds >= SLOW_SECONDS).sort((a, b) => b.seconds - a.seconds).slice(0, MOST_SLOW);
  return [...(failed.length ? [allFailed(failed)] : []), ...slow.map((c) => `::warning ${place(c)}title=${property(`slow: ${label(c)}`)}::took ${c.seconds.toFixed(1)} s`)];
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: ci-annotate.ts report.xml"); process.exit(2); }
  let xml: string;
  try { xml = readFileSync(file, "utf8"); } catch { console.log("::warning title=no test report::the test runner wrote no report"); process.exit(0); }
  for (const line of annotations(xml)) console.log(line);
}
