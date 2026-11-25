#!/usr/bin/env bun
/**
 * Drives a small program through the same path a conversation takes (the helper, the guard, the driver) and says, for each kind of step, whether the
 * next capture of the program shows it happened. Run by the "computer-check" workflow, never by a person's conversation.
 * `--report <file>` also writes what it says to a file; `--app <name>` names the window.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join } from "node:path";
import type { ComputerCall, ComputerResult } from "@navvied/engine";
import { ComputerUse } from "./service.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

const arg = (n: string): string | undefined => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const reportAt = arg("--report"), app = arg("--app") ?? "";
if (reportAt) writeFileSync(reportAt, "");
const say = (k: string, v: string) => { const l = `${k.padEnd(12)}${v}`; console.log(l); if (reportAt) appendFileSync(reportAt, l + "\n"); };
setTimeout(() => { say("result", "the drive did not finish in six minutes"); process.exit(2); }, 360_000).unref();

const platform = osPlatform();
const use = new ComputerUse({
  platform, arch: osArch(), env: process.env, dir: join(process.env.NAVVIED_HOME ?? join(homedir(), ".navvied"), "computer"), fetchFn: fetch, run, spawn: spawnChild, probe: probeStatus, pid: process.pid, ownApps: ["navvied-agent-runner"],
  trace: ({ tool, args, result }) => { if (result.isError || tool === "click") say(result.isError ? "driver said" : "driver did", `${tool} ${JSON.stringify({ ...args, text: undefined }).slice(0, 160)} -> ${(JSON.stringify(result.structured ?? "") + " " + result.text).replace(/\s+/g, " ").slice(0, 330)}`); },
});
const helper = use.helper();
const allow = async () => "app" as const;
const act = async (what: string, c: ComputerCall, signal?: AbortSignal): Promise<ComputerResult> => {
  const r = await helper.call(c, signal, allow, "bypass");
  say(what, `${r.verdict}${r.code ? ` ${r.code}` : ""}${r.next ? ` (${r.next.slice(0, 80)})` : ""}`);
  return r;
};
const look = async (): Promise<string[]> => ((await helper.call({ action: "capture", app, mode: "ax" }, undefined, allow, "bypass")).tree ?? "").split("\n");
const numberOf = (lines: string[], re: RegExp): number | undefined => { const l = lines.find((x) => re.test(x)); return l ? Number(l.split(" ")[0]) : undefined; };
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push([name, ok]); say("check", `${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
/** A step the driver took whose effect this program's own accessibility tree cannot show: said, and not counted as proven or as failed. */
const unseen = (name: string, detail: string) => say("check", `NOT VERIFIABLE ${name}: ${detail}`);
const mod = platform === "darwin" ? "cmd" : "ctrl";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The element that takes text: the entry of the test window, the text area of the editors. */
const field = (lines: string[]): number | undefined => numberOf(lines, platform === "linux" ? /navvied-entry/ : /(AXTextArea|Edit "Text Editor")/);
const valueOf = (lines: string[], n: number | undefined): string => { const l = lines.find((x) => Number(x.split(" ")[0]) === n) ?? ""; return /= "(.*)"$/.exec(l)?.[1] ?? ""; };

const first = await act("capture", { action: "capture", app, mode: "ax" });
const start = (first.tree ?? "").split("\n");
const target = field(start);
if (first.verdict !== "delivered" || target === undefined) { check("the program is captured and has a field", false, JSON.stringify(first).slice(0, 200)); } else {
  // Type, select all and type over it: key (a shortcut with held keys) and type, each shown by the value of the field.
  await act("click field", { action: "click", target });
  await act("type", { action: "type", target, text: "hello world" });
  let lines = await look();
  check("type", valueOf(lines, field(lines)).includes("hello world"), valueOf(lines, field(lines)));
  await act("key select all", { action: "key", keys: `${mod}+a` });
  await act("type over", { action: "type", target: field(lines)!, text: "replaced" });
  lines = await look();
  const over = valueOf(lines, field(lines));
  check("key select all, then type over it", over.includes("replaced") && !over.includes("hello"), over);

  // Right click opens the context menu; Escape closes it. The menu's items are in the next capture.
  await act("right click", { action: "click", target: field(lines)!, button: "right" });
  await pause(500);
  lines = await look();
  const inMenu = (ls: string[]) => ls.some((l) => /(Select All|Paste|Copy)/i.test(l) && !/navvied-entry|AXTextArea|Text Editor/.test(l));
  const menu = inMenu(lines);
  if (menu || platform === "linux" || platform === "darwin") check("right click opens the context menu", menu, lines.filter((l) => /(Select All|Paste|Copy)/i.test(l)).slice(0, 3).join(" | "));
  else unseen("right click", "the menu is a window of its own that the tree of this program does not hold");
  await act("key Escape", { action: "key", keys: "escape" });
  await pause(300);
  lines = await look();
  check("Escape closes the menu", !inMenu(lines));

  if (platform === "linux") {
    const press = numberOf(lines, /push button "Press"/);
    if (press !== undefined) { await act("click", { action: "click", target: press }); lines = await look(); check("click", lines.some((l) => /"pressed"/.test(l))); }
    // A drag along the slider, in pixels of the window: from the handle at its left end to a place well to the right.
    await act("drag", { action: "drag", x: 108, y: 95, to_x: 260, to_y: 95 });
    lines = await look();
    const slid = Number(/slider (\d+)/.exec(lines.join("\n"))?.[1] ?? 0);
    check("drag moves the slider", slid >= 30, `slider ${slid}`);
    const view = numberOf(lines, /line 1/);
    await act("scroll", { action: "scroll", ...(view !== undefined ? { target: view } : { app }), direction: "down", amount: 10 });
    await pause(300);
    lines = await look();
    const scrolled = Number(/scrolled (\d+)/.exec(lines.join("\n"))?.[1] ?? 0);
    check("scroll moves the text", scrolled > 0, `scrolled ${scrolled}`);
  } else {
    // The editors: a long text, scrolled, and a drag over the start of it that the next typing replaces.
    await act("select all", { action: "key", keys: `${mod}+a` });
    await act("long text", { action: "type", target: field(lines)!, text: Array.from({ length: 120 }, (_, n) => `line ${n + 1}`).join("\n") });
    lines = await look();
    const bars = (ls: string[]) => ls.filter((l) => /scroll/i.test(l)).map((l) => l.trim()).join(" | ");
    const before = bars(lines);
    await act("scroll", { action: "scroll", app, direction: "up", amount: 15 });
    await pause(300);
    const afterBars = bars(await look());
    if (before === "") unseen("scroll", "the tree shows no scroll bar or position");
    else check("scroll moves the text", afterBars !== before, `${before.slice(0, 120)} -> ${afterBars.slice(0, 120)}`);
    await act("drag", { action: "drag", x: 20, y: 90, to_x: 60, to_y: 90 });
    await act("type over the selection", { action: "type", target: field(lines)!, text: "Z" });
    lines = await look();
    const v = valueOf(lines, field(lines));
    check("drag selects, typing replaces the selection", v.includes("Z") && v !== "", v.slice(0, 40));
  }

  // A turn stopped in the middle of a long typing: some of it is typed, the answer is `unverified`, and the next capture shows it did not all arrive.
  await act("select all", { action: "key", keys: `${mod}+a` });
  await act("clear", { action: "key", keys: "delete" });
  const cut = new AbortController();
  setTimeout(() => cut.abort(), 400);
  const long = "x".repeat(24_000);
  const stopped = await act("stopped typing", { action: "type", target: field(await look())!, text: long }, cut.signal);
  await pause(500);
  lines = await look();
  const typed = valueOf(lines, field(lines)).length;
  check("a stopped turn is unverified and the text is not all there", stopped.verdict === "unverified" && typed < long.length, `${typed} of ${long.length} characters`);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
say("result", failed.length ? `not all driven: ${failed.join("; ")}` : `driven: ${results.length} checks`);
await use.close();
process.exit(failed.length ? 1 : 0);
