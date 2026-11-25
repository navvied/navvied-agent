#!/usr/bin/env bun
/**
 * Run by a person on the computer to be checked: `bun run computer:check`. It fetches the pinned driver (hash and signature checked), starts it the way the app does, reads its tool list
 * and stops it. It sends no input to any program. The result is for whoever reads it to know what really happened on this system.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join } from "node:path";
import { describeTools } from "./describe.ts";
import { findNumber, firstNumber } from "./find.ts";
import { DriverHost, missingFrom } from "./host.ts";
import { install } from "./install.ts";
import { PIN, supportOf } from "./pin.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

/** `--report <file>` also writes everything to a file, for a CI step to show as one annotation. */
const reportAt = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : undefined;
if (reportAt) writeFileSync(reportAt, "");
const say = (k: string, v: string) => { const l = `${k.padEnd(10)}${v}`; console.log(l); if (reportAt) appendFileSync(reportAt, l + "\n"); };
// A check that does not end in two minutes ends itself, with what it has said so far.
setTimeout(() => { say("result", "the check did not finish in two minutes"); process.exit(2); }, 120_000).unref();
const platform = osPlatform(), arch = osArch();
const sup = supportOf(platform, arch, process.env);
say("system", `${platform} ${arch}`);
if (!sup.ok) { say("result", sup.message); process.exit(1); }
say("driver", `${PIN.version} (${sup.target})`);

const dir = join(process.env.NAVVIED_HOME ?? join(homedir(), ".navvied"), "computer");
const got = await install({ fetchFn: fetch, run, dir, pin: PIN, target: sup.target, platform, onProgress: (b, t) => { if (t) process.stdout.write(`\rdownload  ${Math.round((100 * b) / t)}%`); } });
process.stdout.write("\n");
if (!got.ok) { say("result", got.why === "download" ? `download failed (${got.result.why})` : got.message); process.exit(1); }
say("signature", PIN.assets[sup.target].signer.kind === "none" ? "none to check on this system (hash only)" : "valid");

const host = new DriverHost({ entry: got.entry, pin: PIN, platform, env: process.env, stateDir: join(dir, "run"), pid: process.pid, spawn: spawnChild, probe: probeStatus });
const started = await host.start();
if (!started.ok) { say("result", started.message); await host.close(); process.exit(1); }
const tools = await started.client.tools();
const listing = join(dir, "run", "tools.json");
writeFileSync(listing, JSON.stringify(tools, null, 2));
say("tools", `${tools.length}, written in full to ${listing}`);
say("missing", missingFrom(PIN, tools).join(", ") || "none");
say("surface", `\n${describeTools(tools)}`);
for (const t of tools.filter((x) => ["get_window_state", "list_apps", "list_windows", "click", "type_text", "press_key", "hotkey", "scroll", "drag"].includes(x.name))) say(`about ${t.name}`, (t.description ?? "").replace(/\s+/g, " ").slice(0, 600));
// Looking only, no input: what the driver says about this computer's programs and windows, as it is.
const shown = (r: { isError: boolean; text: string; structured?: unknown }) => `${r.isError ? "error: " : ""}${JSON.stringify(r.structured ?? null).slice(0, 6000)}${r.text ? `\ntext: ${r.text.slice(0, 600)}` : ""}`;
const ask = async (name: string, args: Record<string, unknown>) => {
  try { const r = await started.client.call(name, args, 30_000); say(name, shown(r)); return r; } catch (e) { say(name, `no answer: ${e instanceof Error ? e.message : e}`); return undefined; }
};
try { const r = await started.client.call("list_apps", {}, 30_000); say("list_apps", `${r.text.split("\n")[0] ?? ""} (first record: ${JSON.stringify((r.structured as { apps?: unknown[] } | undefined)?.apps?.[0] ?? null)})`); } catch (e) { say("list_apps", `no answer: ${e instanceof Error ? e.message : e}`); }
const windows = await ask("list_windows", {});
// `--app <name>`: the shape of what the driver reads from one open window (looking only, no input).
const needle = process.argv.includes("--app") ? process.argv[process.argv.indexOf("--app") + 1] : undefined;
if (needle) {
  const pid = windows ? findNumber(windows.structured, "pid", needle) : undefined;
  const windowId = windows ? findNumber(windows.structured, "window_id", needle) : undefined;
  if (pid === undefined) say("target", `no open window matches "${needle}"`);
  else {
    say("target", `${needle} is pid ${pid}, window ${windowId}`);
    await ask("get_window_state", { pid, ...(windowId !== undefined ? { window_id: windowId } : {}), tree_format: "both", include_screenshot: false, full_output: true, timeout_ms: 8000 });
  }
}
say("result", "the driver starts and answers; no input was sent");
await host.close();
process.exit(0);
