import { discard, installPlugin, plainSource, stagePlugin, type Pack, type PluginLock } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";

type Answer = Extract<EngineEvent, { ev: "plugin.install" }>;

/** What a plugin brings and every command it would run, with where each comes from: what the person is asked about before it is installed (the same facts `navvied plugin install` prints after it). */
const described = (pack: Pack): Pick<Answer, "name" | "version" | "description" | "hash" | "brings" | "runs" | "findings"> => ({
  name: pack.name, version: pack.version, description: pack.description, hash: pack.hash,
  brings: { skills: pack.skills, agents: pack.agents, commands: pack.commands, hooks: Object.values(pack.hooks).reduce((n, list) => n + (list?.length ?? 0), 0), mcp: Object.keys(pack.mcp) },
  runs: pack.runs.map((r) => ({ what: r.what, command: r.command, source: r.source, ...(r.findings?.length ? { findings: r.findings } : {}) })),
  ...(pack.findings.length ? { findings: pack.findings } : {}),
});

/**
 * The page's way to install a plugin, in the two steps the person is asked in. Without a fingerprint the files are fetched and read as hostile input, nothing is run and nothing is put
 * in the person's folder: the answer is `ask`. With the fingerprint of that answer the same files are fetched again and installed only if they are still exactly those; the plugin is off.
 */
export async function pluginInstall(cmd: { from: string; fingerprint?: string }, where: { root: string; lock: PluginLock }, fetcher?: typeof fetch): Promise<Answer> {
  const from = plainSource(cmd.from);
  if (!cmd.fingerprint) {
    const got = await stagePlugin({ from: cmd.from, root: where.root, ...(fetcher ? { fetch: fetcher } : {}) });
    if (!got.ok) return { ev: "plugin.install", state: "failed", from, error: got.error };
    discard(got);
    return { ev: "plugin.install", state: "ask", from, ...described(got.pack) };
  }
  const done = await installPlugin({ from: cmd.from, root: where.root, lock: where.lock, expectHash: cmd.fingerprint, replace: true, ...(fetcher ? { fetch: fetcher } : {}) });
  return done.ok ? { ev: "plugin.install", state: "done", from, ...described(done.pack) } : { ev: "plugin.install", state: "failed", from, error: done.error };
}
