import { dirname, resolve } from "node:path";
import { installPlugin, removePlugin, type Pack } from "@navvied/engine";
import type { Options } from "../args.ts";
import { configPath, loadConfig, pluginStatePath, skillTrustPath } from "../config.ts";
import type { IO } from "../io.ts";
import { PluginState, SkillTrust, packInfo, packTrustKey, pluginId, pluginPlaces, readPacks } from "../plugins.ts";
import { EXIT } from "./run.ts";

const USAGE = `usage:
  navvied plugin install <folder | archive | git address> [<fingerprint>]   copy it here; nothing in it is run, and it stays off
  navvied plugin list
  navvied plugin show <name>      what it brings and every command it would run
  navvied plugin on <name>        switch it on (a project's plugin must be accepted first)
  navvied plugin off <name>
  navvied plugin accept <name>    accept a plugin that comes with this project
  navvied plugin remove <name>`;

const showRuns = (pack: Pack): string[] => [...(pack.runs.length ? pack.runs.map((r) => `  ${r.what}: ${r.command}  (${r.source})`) : ["  It runs no commands."]), ...pack.findings.map((f) => `  Found in its text, ${f}`)];

/** `navvied plugin …`: the plugins on this computer. Installing never runs anything and never switches anything on. */
export async function pluginCommand(rest: string | undefined, options: Options, io: IO): Promise<number> {
  const words = (rest ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = words.shift();
  const say = (text: string): void => { io.stdout.write(`${text}\n`); };
  const fail = (text: string): number => { io.stderr.write(`error: ${text}\n`); return EXIT.usage; };
  const file = configPath(io.env, options.config);
  const cfg = loadConfig(file, io.env);
  const cwd = resolve(options.cwd ?? process.cwd());
  const places = pluginPlaces(file);
  const state = new PluginState(pluginStatePath(io.env));
  const trust = new SkillTrust(skillTrustPath(io.env), cfg.ok && cfg.value?.skills?.trust === "confirm");
  const packs = (): Pack[] => readPacks(dirname(file), places.lock, cwd);

  if (sub === "install") {
    const [from, fingerprint] = words;
    if (!from) return fail(USAGE);
    const done = await installPlugin({ from, root: places.root, lock: places.lock, ...(fingerprint ? { expectHash: fingerprint } : {}), replace: true });
    if (!done.ok) return fail(done.error);
    say(`Installed ${done.pack.name} ${done.pack.version}. It is off.`);
    say(`Fingerprint ${done.pack.hash}`);
    for (const line of showRuns(done.pack)) say(line);
    return EXIT.ok;
  }
  if (sub === "list") {
    const all = packs();
    if (!all.length) { say("No plugins."); return EXIT.ok; }
    for (const p of all) {
      const i = packInfo(p, state, trust, places.lock, cwd);
      say(`${p.name.padEnd(20)} ${p.version.padEnd(10)} ${p.source.padEnd(8)} ${p.problem ? `unusable: ${p.problem}` : i.enabled ? (i.trusted ? "on" : "on, waiting for you to accept it") : "off"}`);
    }
    return EXIT.ok;
  }
  if (!sub || !["show", "on", "off", "accept", "remove"].includes(sub)) return fail(USAGE);
  const pack = packs().find((p) => p.name === words[0]);
  if (!pack) return fail(`no plugin called ${words[0] ?? ""}`);
  if (sub === "show") {
    say(`${pack.name} ${pack.version}: ${pack.description}`);
    say(`Fingerprint ${pack.hash}`);
    say(`Brings: skills ${pack.skills.length}, agents ${pack.agents.length}, commands ${pack.commands.length}`);
    for (const line of showRuns(pack)) say(line);
    return pack.problem ? fail(pack.problem) : EXIT.ok;
  }
  if (sub === "remove") {
    if (pack.source !== "user") return fail("a plugin that comes with a project is removed from the project's folder");
    removePlugin(places.root, places.lock, pack.name);
    state.forget(pluginId(pack.name));
    say(`Removed ${pack.name}.`);
    return EXIT.ok;
  }
  if (pack.problem) return fail(pack.problem);
  if (sub === "accept") {
    if (pack.source !== "project") return fail("only a plugin that comes with a project is accepted");
    trust.answer(packTrustKey(pack), true);
    say(`Accepted ${pack.name} as it is now. It is still off until you switch it on.`);
    return EXIT.ok;
  }
  state.set(pluginId(pack.name), sub === "on");
  say(`${pack.name} is ${sub}. It applies from the next conversation.`);
  return EXIT.ok;
}
