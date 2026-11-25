#!/usr/bin/env bun
/**
 * Run by a person on the computer to be checked: `bun run computer:check`. It fetches the pinned driver (hash and signature checked), starts it the way the app does, reads its tool list
 * and stops it. It sends no input to any program. The result is for whoever reads it to know what really happened on this system.
 */
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join } from "node:path";
import { DriverHost, missingFrom } from "./host.ts";
import { install } from "./install.ts";
import { PIN, supportOf } from "./pin.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

const say = (k: string, v: string) => console.log(`${k.padEnd(10)}${v}`);
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
say("tools", `${tools.length}`);
say("missing", missingFrom(PIN, tools).join(", ") || "none");
say("result", "the driver starts and answers; no input was sent");
host.stop();
setTimeout(() => process.exit(0), 100);
