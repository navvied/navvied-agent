#!/usr/bin/env bun
/**
 * Run by a person on the computer to be checked: `bun run computer:check`. It fetches the pinned driver (hash and signature checked), starts it the way the app does, reads its tool list
 * and stops it. It sends no input to any program. The result is for whoever reads it to know what really happened on this system.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join } from "node:path";
import { describeTools } from "./describe.ts";
import { DriverHost, missingFrom } from "./host.ts";
import { install } from "./install.ts";
import { PIN, supportOf } from "./pin.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

/** `--report <file>` also writes everything to a file, for a CI step to show as one annotation. */
const reportAt = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : undefined;
if (reportAt) writeFileSync(reportAt, "");
const say = (k: string, v: string) => { const l = `${k.padEnd(10)}${v}`; console.log(l); if (reportAt) appendFileSync(reportAt, l + "\n"); };
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
if (!started.ok) { say("result", started.message); host.stop(); process.exit(1); }
const tools = await started.client.tools();
const listing = join(dir, "run", "tools.json");
writeFileSync(listing, JSON.stringify(tools, null, 2));
say("tools", `${tools.length}, written in full to ${listing}`);
say("missing", missingFrom(PIN, tools).join(", ") || "none");
say("surface", `\n${describeTools(tools)}`);
// Looking only, no input: what the driver says about this computer's programs and windows, as it is.
for (const name of ["list_apps", "list_windows"]) {
  try { const r = await started.client.call(name, {}, 20_000); say(name, `${r.isError ? "error: " : ""}${r.text.slice(0, 1500)}`); } catch (e) { say(name, `no answer: ${e instanceof Error ? e.message : e}`); }
}
say("result", "the driver starts and answers; no input was sent");
host.stop();
setTimeout(() => process.exit(0), 100);
