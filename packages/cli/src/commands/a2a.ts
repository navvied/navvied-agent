/**
 * Agent-to-agent calls, from the command line:
 *   navvied serve --a2a        let other agents ask this computer (off until started)
 *   navvied a2a add <name>     make the token for an agent; it is shown once
 *   navvied a2a list           the agents that may ask
 *   navvied a2a revoke <name>  take a token back
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PermMode } from "@navvied/protocol";
import { defaultTools, type Skill, type Tool } from "@navvied/engine";
import { addToken, revokeToken } from "../a2a-admin.ts";
import { DEFAULT_LIMITS, type A2aConfig } from "../a2a-config.ts";
import { engineRunner } from "../a2a-runner.ts";
import { startA2aServer, type A2aServer } from "../a2a-server.ts";
import { PeerTokens } from "../a2a-tokens.ts";
import type { Options } from "../args.ts";
import { a2aAuditPath, a2aTokensPath, configPath, loadConfig, pluginStatePath } from "../config.ts";
import { createEngine } from "../create.ts";
import { VERSION } from "../help.ts";
import type { IO } from "../io.ts";
import { PluginState } from "../plugins.ts";
import { CATEGORIES, TOOL_ROWS } from "../tool-table.ts";
import { toolSwitch } from "../tools-info.ts";
import { EXIT } from "./run.ts";

/** What peers are not offered however the person's switches are set (see create.ts `INBOUND_OFF`) and rows that make no sense to another agent. */
const NOT_A_SKILL = new Set(["ask", "todo", "memory", "session-search", "skills"]);

/** What this agent can do for a peer, in the words of the tools list: the rows whose tools are on and that the mode lets through (in plan mode, only the ones whose main tool reads). */
export function skillsFor(mode: PermMode, tools: readonly Tool[], on: (name: string) => boolean): Skill[] {
  return TOOL_ROWS.filter((r) => !NOT_A_SKILL.has(r.id)).flatMap((row) => {
    const own = tools.filter((t) => row.names.includes(t.name) && on(t.name));
    // A row is something the agent can do when its main tool (the first of the row) is on and, in plan mode, only reads: BashOutput reads, but without Bash there is nothing to read.
    const main = own.find((t) => t.name === row.names[0]);
    return main && (mode !== "plan" || main.readOnly) ? [{ id: row.id, name: row.title, description: row.about, tags: [CATEGORIES.find((c) => c.id === row.category)?.title ?? row.category] }] : [];
  });
}

const auditTo = (path: string): NonNullable<Parameters<typeof startA2aServer>[0]["audit"]> => (line) => {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* not supported on this system */ }
  } catch { /* a record is a convenience: it never stops a task */ }
};

export type StartedA2a = { ok: true; server: A2aServer; tokens: PeerTokens; config: A2aConfig } | { ok: false; error: string };

/** The server that lets other agents ask this computer. The mode, the limits and the card come from the configuration; `--port` and `--host` from the command line. */
export function startA2a(options: Options, io: IO, port?: number): StartedA2a {
  const path = configPath(io.env, options.config);
  const file = loadConfig(path, io.env);
  if (!file.ok) return file;
  const config: A2aConfig = file.value?.a2a ?? { mode: "plan", peers: {}, limits: DEFAULT_LIMITS };
  const mode = config.mode;
  const tokens = new PeerTokens(a2aTokensPath(io.env));
  const on = toolSwitch(new PluginState(pluginStatePath(io.env)));
  const runner = engineRunner((emit, session) => { const c = createEngine({ ...options, session, kind: "agent", http: false }, io, emit, { inbound: true }); return c.ok ? { ok: true, value: c.value.engine } : c; }, mode, (what) => io.stderr.write(`a2a: ${what.slice(0, 300)}\n`));
  const server = startA2aServer({
    tokens, runner, limits: config.limits,
    card: { name: config.name ?? "navvied", description: config.description ?? "A coding agent on this computer. It answers in plain text.", version: VERSION, skills: skillsFor(mode, defaultTools(), on) },
    host: options.host ?? "127.0.0.1",
    port: port ?? options.port ?? config.port ?? 8788,
    ...(config.url ? { url: config.url } : {}),
    audit: auditTo(a2aAuditPath(io.env)),
  });
  return { ok: true, server, tokens, config };
}

export async function serveA2aCommand(options: Options, io: IO): Promise<number> {
  const started = startA2a(options, io);
  if (!started.ok) { io.stderr.write(`error: ${started.error}\n`); return EXIT.usage; }
  const { server, tokens, config } = started;
  if (options.readyLine) io.stderr.write(`navvied-ready ${JSON.stringify({ port: server.port })}\n`);
  else {
    io.stderr.write(`Other agents can ask this computer at ${server.url}/\nTheir conversations run in ${config.mode} mode.\n`);
    if (!tokens.list().length) io.stderr.write("\nNo agent has a token yet. Make one with: navvied a2a add <name>\n");
  }
  await new Promise<void>((resolveStop) => {
    const off = io.onInterrupt(() => { off(); resolveStop(); });
    if (options.exitWhenStdinCloses) void (async () => { try { for await (const _ of io.stdin) { /* only the end matters */ } } catch { /* a broken pipe is an end too */ } off(); resolveStop(); })();
  });
  await server.stop();
  return EXIT.ok;
}

const day = (ms: number | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "never");

/** `navvied a2a add|list|revoke`. */
export function a2aCommand(text: string | undefined, io: IO): number {
  const [verb, name] = (text ?? "").trim().split(/\s+/);
  const tokens = new PeerTokens(a2aTokensPath(io.env));
  if (verb === "add" && name) {
    const made = addToken(tokens, name);
    if (!made.ok) { io.stderr.write(`error: ${made.error}\n`); return EXIT.usage; }
    io.stdout.write(`Token for ${name}. It is shown only now; give it to that agent and keep it private.\n\n  ${made.value.token}\n`);
    return EXIT.ok;
  }
  if (verb === "revoke" && name) {
    const gone = revokeToken(tokens, name);
    if (!gone.ok) { io.stderr.write(`error: ${gone.error}\n`); return EXIT.usage; }
    io.stdout.write(`The token of ${name} no longer works.\n`);
    return EXIT.ok;
  }
  if (verb === "list" && !name) {
    const list = tokens.list();
    if (!list.length) { io.stdout.write("No agent may ask this computer yet. Make a token with: navvied a2a add <name>\n"); return EXIT.ok; }
    const width = Math.max(...list.map((t) => t.name.length)) + 2;
    for (const t of list) io.stdout.write(`${t.name.padEnd(width)}made ${day(t.createdAt)}   last used ${day(t.lastUsed)}\n`);
    return EXIT.ok;
  }
  io.stderr.write("usage: navvied a2a add <name> | list | revoke <name>\n");
  return EXIT.usage;
}
