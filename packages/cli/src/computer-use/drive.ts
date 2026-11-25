#!/usr/bin/env bun
/**
 * Drives a small program through the same path a conversation takes (the helper, the guard, the driver) and says what happened: a capture, then a
 * click on the button of the test window on Linux, or typing into Notepad on Windows. Run by the "computer-check" workflow, never by a person's
 * conversation. `--report <file>` also writes what it says to a file; `--app <name>` names the window.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join } from "node:path";
import type { ComputerResult } from "@navvied/engine";
import { ComputerUse } from "./service.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

const arg = (n: string): string | undefined => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const reportAt = arg("--report"), app = arg("--app") ?? "";
if (reportAt) writeFileSync(reportAt, "");
const say = (k: string, v: string) => { const l = `${k.padEnd(10)}${v}`; console.log(l); if (reportAt) appendFileSync(reportAt, l + "\n"); };
setTimeout(() => { say("result", "the drive did not finish in three minutes"); process.exit(2); }, 180_000).unref();

const platform = osPlatform();
const use = new ComputerUse({
  platform, arch: osArch(), env: process.env, dir: join(process.env.NAVVIED_HOME ?? join(homedir(), ".navvied"), "computer"), fetchFn: fetch, run, spawn: spawnChild, probe: probeStatus, pid: process.pid, ownApps: ["navvied-agent-runner"],
});
const helper = use.helper();
const allow = async () => "app" as const;
const step = async (what: string, c: Parameters<typeof helper.call>[0]): Promise<ComputerResult> => {
  const r = await helper.call(c, undefined, allow, "bypass");
  say(what, `${r.verdict}${r.code ? ` ${r.code}` : ""}${r.next ? ` (${r.next})` : ""}${r.tree ? `\n${r.tree}` : ""}`);
  return r;
};

let ok = true;
const first = await step("capture", { action: "capture", app, mode: "ax" });
if (first.verdict === "delivered") {
  const lines = (first.tree ?? "").split("\n");
  if (platform === "linux") {
    const press = lines.find((l) => /button "Press"/.test(l));
    if (!press) { say("click", "the button was not in the capture"); ok = false; }
    else {
      await step("click", { action: "click", target: Number(press.split(" ")[0]) });
      const again = await step("capture", { action: "capture", app, mode: "ax" });
      ok = (again.tree ?? "").includes("pressed");
      say("check", ok ? "the label now says pressed" : "the label did not change");
    }
  } else if (platform === "win32" || platform === "darwin") {
    const edit = lines.find((l) => /(edit|document|text)/i.test(l) && !/ruler|button/i.test(l));
    if (!edit) { say("type", "no text area was in the capture"); ok = false; }
    else {
      await step("type", { action: "type", target: Number(edit.split(" ")[0]), text: "navvied was here" });
      const again = await step("capture", { action: "capture", app, mode: "ax" });
      ok = (again.tree ?? "").includes("navvied was here");
      say("check", ok ? "the typed text is in the window" : "the typed text was not found");
    }
  }
} else if (platform === "linux") ok = false;
say("result", ok ? "driven" : "not driven");
await use.close();
process.exit(ok ? 0 : 1);
