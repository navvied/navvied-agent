import { leanSoul, referenceFor, soulFor, type Brain } from "./soul.ts";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ChatCompletionsProvider, type Recall, loadAgents, Rules, hasRules, parseRules, type RuleSet, commandHooks, memoryText, connectMcp, loadSkills, projectDirs, type ModelSwitch, Checkpoints, Engine, FileSessionStore, MessagesApiProvider, OllamaProvider, ResponsesApiProvider, SMALL_WINDOW, defaultTools, instructionFiles, loadInstructions, type AgentEngine, type ChatCompletionsConfig, type Credentials, type Provider, FallbackProvider, type FallbackLink, type RetryOptions } from "@navvied/engine";
import { randomUUID } from "node:crypto";
import { CodexEngine, StreamEngine } from "@navvied/stream-engine";
import type { Effort, EngineEvent, Result } from "@navvied/protocol";
import type { Options } from "./args.ts";
import { activeTools } from "./tools-info.ts";
import { TerminalState, backendFor } from "./terminal.ts";
import { attachmentsDir, chatFilesDir, chatSessionsDir, checkpointsDir, configPath, loadConfig, pluginStatePath, terminalStatePath, resolveModel, sessionsDir, type ConfigFile, type ModelEntry } from "./config.ts";
import type { IO } from "./io.ts";
import { memoryPathsFor } from "./memory-ui.ts";
import { catalogOf } from "./account.ts";
import { INSTRUCTION_FILE_NAMES, knownEffort } from "./presets.ts";
import { credentialsFor } from "./logins.ts";
import { PluginState, activeHooks, activeSkills, mcpId } from "./plugins.ts";

/** `where` says in plain words how the model is reached, for the welcome screen. */
export interface Created { engine: AgentEngine; /** The name of the model in the configuration. */ entry: string; modelName: string; where: string; cwd: string; tools?: string[]; notes: string[]; /** The model is reached through a program the person is signed in to, which keeps its own sessions. */ program?: true }

const providerFor = (api: "chat" | "messages" | "responses" | "ollama" | undefined, cfg: ChatCompletionsConfig, window: number, credentials?: Credentials, pdf?: boolean): Provider =>
  api === "messages" ? new MessagesApiProvider({ ...(pdf ? { readsPdf: true } : {}), baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...(cfg.headers ? { headers: cfg.headers } : {}), ...(credentials ? { credentials } : {}) })
  : api === "responses" ? new ResponsesApiProvider({ ...(pdf ? { readsPdf: true } : {}), baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...(cfg.headers ? { headers: cfg.headers } : {}), ...(credentials ? { credentials } : {}) })
  : api === "ollama" ? new OllamaProvider({ baseUrl: cfg.baseUrl, model: cfg.model, contextTokens: window, ...(cfg.headers ? { headers: cfg.headers } : {}) })
  : new ChatCompletionsProvider(cfg);

/**
 * The permission rules for a project: the person's own (allow, ask, deny) plus, when the project has a `.navvied/permissions.json`,
 * the ones it can only make stricter (ask, deny). A project can never allow anything: it is not the person's own word.
 */
function rulesFor(own: RuleSet | undefined, cwd: string): Rules | undefined {
  let project: RuleSet = { allow: [], ask: [], deny: [] };
  try { project = parseRules(JSON.parse(readFileSync(join(cwd, ".navvied", "permissions.json"), "utf8"))); } catch { /* none, or not readable */ }
  const set: RuleSet = { allow: own?.allow ?? [], ask: [...(own?.ask ?? []), ...project.ask], deny: [...(own?.deny ?? []), ...project.deny] };
  return hasRules(set) ? new Rules(set, cwd) : undefined;
}

/** The script that is this program when it runs from source: the one it was started with, or (under a test runner, which is started with its own) the one next to this file. */
const sourceScript = (): string | undefined => (process.argv[1] && /[\\/]main\.ts$/.test(process.argv[1]) ? process.argv[1] : process.argv[1] && !process.argv[1].startsWith("/$bunfs") && !process.argv[1].startsWith("B:\\~BUN") ? join(import.meta.dir, "main.ts") : process.argv[1]);

/** The words that start this very program again: itself when it is the single compiled file, else the runtime and the script. */
export function selfArgv(exec: string = process.execPath, script: string | undefined = sourceScript()): string[] {
  const compiled = !script || script.startsWith("/$bunfs") || script.startsWith("B:\\~BUN") || /[\\/]navvied(\.exe)?$/.test(exec);
  return compiled ? [exec] : [exec, script!];
}

/** The command a program runs before each of its tools: this very program, asked to `guard`, with the same configuration. */
export function guardCommandFor(configFile: string, cwd: string, platform: NodeJS.Platform = process.platform, exec: string = process.execPath, script: string | undefined = sourceScript()): string {
  const q = (s: string): string => (platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
  const compiled = !script || script.startsWith("/$bunfs") || script.startsWith("B:\\~BUN") || /[\\/]navvied(\.exe)?$/.test(exec);
  return [q(exec), ...(compiled ? [] : [q(script!)]), "guard", "--config", q(configFile), "--cwd", q(cwd)].join(" ");
}

/** `NAVVIED_RETRIES`: how many more times a call to the model that failed is made again (default 7; 0 never). */
const retryFrom = (env: Record<string, string | undefined>): RetryOptions => {
  const more = Number(env.NAVVIED_RETRIES);
  return env.NAVVIED_RETRIES !== undefined && Number.isInteger(more) && more >= 0 && more <= 20 ? { attempts: more + 1 } : {};
};

/** The chosen model, then the ones the person named as a second choice, tried in that order when it cannot be reached. */
function withFallback(first: Provider, name: string, file: ConfigFile | null, env: Record<string, string | undefined>, path: string, emit: (e: EngineEvent) => void): Provider {
  const retry = retryFrom(env);
  const chain: FallbackLink[] = [{ name, provider: first }];
  for (const other of file?.fallback ?? []) {
    if (other === name || chain.some((l) => l.name === other)) continue;
    const next = resolved(other, file, env, path);
    if (!next.ok || next.value.cli || !next.value.provider) continue;
    chain.push({ name: file?.models[other]?.display?.name ?? other, provider: providerFor(next.value.api, next.value.provider, next.value.window, next.value.signIn ? credentialsFor(next.value.signIn, env) : undefined, next.value.pdf) });
  }
  return chain.length > 1 ? new FallbackProvider(chain, (msg) => emit({ ev: "notice", msg }), retry) : first;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** In words, how a configured model is reached. */
export function describeEntry(e: ModelEntry): string {
  if (e.signIn) return e.signIn.provider === "claude" ? "Through your Claude subscription, with navvied's own tools." : "Through your ChatGPT plan, with navvied's own tools.";
  if (e.command) return e.adapter === "codex" ? "Through your ChatGPT plan." : "Through a program you are signed in to.";
  try { return LOCAL_HOSTS.has(new URL(e.baseUrl ?? "").hostname) ? "On this computer." : "A hosted service."; } catch { return "A hosted service."; }
}

function describeModel(cli: { adapter?: string } | undefined, baseUrl: string | undefined): string {
  if (cli) return cli.adapter === "codex" ? "through your ChatGPT plan" : "through a program you are signed in to";
  try { return LOCAL_HOSTS.has(new URL(baseUrl ?? "").hostname) ? "running on this computer" : "through a hosted service"; } catch { return "through a hosted service"; }
}

const TOOL_NAMES = (): string[] => defaultTools().map((t) => t.name).filter((n) => n !== "BashOutput" && n !== "BashInput" && n !== "KillShell");
const brainFor = (name: string, model: string | undefined, window: number, shown?: string): Brain => ({ label: `"${shown ?? model ?? name}"`, tools: TOOL_NAMES(), small: window <= SMALL_WINDOW });

/** The models this engine can switch to without starting over: the ones it can run itself. A program is a different kind of engine. */
/** The model as the configuration says, with the effort levels its service documents when the configuration lists none (and says nothing against). */
export function resolved(choice: string | undefined, file: ConfigFile | null, env: Record<string, string | undefined>, path: string): ReturnType<typeof resolveModel> {
  const r = resolveModel(choice, file, env, path);
  if (!r.ok || !r.value.provider || r.value.cli || r.value.efforts || r.value.provider.reasoning === "none") return r;
  const known = knownEffort({ baseUrl: r.value.provider.baseUrl, model: r.value.provider.model, ...(r.value.signIn ? { signIn: r.value.signIn } : {}) });
  if (!known) return r;
  return { ok: true, value: { ...r.value, efforts: known.efforts, provider: { ...r.value.provider, ...(known.field ? { effortField: known.field } : {}) } } };
}

function switcherFor(file: ConfigFile | null, current: string, env: Record<string, string | undefined>, path: string, window: number, efforts: Effort[] | undefined): ModelSwitch | undefined {
  const own = Object.entries(file?.models ?? {}).filter(([, e]) => !e.command);
  if (own.length < 2) return undefined;
  return {
    models: own.map(([id, e]) => ({ id, name: e.display?.name ?? e.model ?? id, blurb: e.display?.blurb ?? describeEntry(e), ...(e.display?.brand ? { brand: e.display.brand } : {}), ...(e.display?.badge ? { badge: e.display.badge } : {}), ...(e.display?.locked ? { locked: true } : {}), ...(catalogOf(id, e) ? { catalog: catalogOf(id, e)! } : {}) })),
    current,
    ...(efforts?.length ? { efforts } : {}),
    use(id) {
      if (file?.models[id]?.display?.locked) return { error: `${file.models[id]!.display!.name ?? id} is not available yet.` };
      const next = resolved(id, file, env, path);
      if (!next.ok) return { error: next.error };
      if (next.value.cli || !next.value.provider) return { error: "That model runs in a different program, so it needs a new conversation." };
      return {
        provider: providerFor(next.value.api, next.value.provider, next.value.window, next.value.signIn ? credentialsFor(next.value.signIn, env) : undefined, next.value.pdf), window: next.value.window,
        ...(next.value.efforts ? { efforts: next.value.efforts } : {}),
        ...(next.value.vision !== undefined ? { vision: next.value.vision } : {}),
        persona: leanSoul(brainFor(id, next.value.provider.model, next.value.window, file?.models[id]?.display?.name)),
        ...(referenceFor(brainFor(id, next.value.provider.model, next.value.window, file?.models[id]?.display?.name)) ? { reference: referenceFor(brainFor(id, next.value.provider.model, next.value.window, file?.models[id]?.display?.name))! } : {}),
      };
    },
  };
}

/** What the hub gives an engine that it cannot make for itself: the person's earlier conversations. */
export interface EngineExtras { recall?: Recall }

export function createEngine(options: Options, io: IO, emit: (e: EngineEvent) => void, extras: EngineExtras = {}): Result<Created> {
  const path = configPath(io.env, options.config);
  const file = loadConfig(path, io.env);
  if (!file.ok) return file;
  const model = resolved(options.model, file.value, io.env, path);
  if (!model.ok) return model;

  const kind = options.kind ?? "agent";
  // A model reached through a program brings its own tools and its own idea of a folder: a chat cannot be held to one with it.
  if (kind === "chat" && model.value.cli) return { ok: false, error: "A chat needs a model that navvied runs itself, not one reached through another program." };
  const cwd = resolve(options.cwd ?? (kind === "chat" ? chatFilesDir(io.env) : process.cwd()));
  if (kind === "chat") { try { mkdirSync(cwd, { recursive: true, mode: 0o700 }); } catch { /* the check below says what is wrong */ } }
  try { if (!statSync(cwd).isDirectory()) throw new Error(); } catch { return { ok: false, error: `--cwd "${cwd}" is not a directory` }; }

  const sessionId = options.session ?? randomUUID();
  const memory = memoryPathsFor(cwd, path);
  const common = { cwd, window: model.value.window, emit };
  const { cli, provider } = model.value;
  const shown = file.value?.models[model.value.name]?.display?.name;
  const brain: Brain = { label: cli ? (cli.adapter === "codex" ? "the model of the user's ChatGPT plan" : "the model of the program the user is signed in to") : `"${shown ?? provider?.model ?? model.value.name}"`, ...(cli ? { program: true, ownTools: TOOL_NAMES() } : { tools: TOOL_NAMES(), small: model.value.window <= SMALL_WINDOW }), ...(kind === "chat" ? { chat: true } : {}) };
  const program = cli && { ...common, ...(rulesFor(file.value?.permissions, cwd) ? { rules: rulesFor(file.value?.permissions, cwd)! } : {}), entry: { id: model.value.name, name: shown ?? model.value.name }, persona: soulFor(brain, loadInstructions(cwd, dirname(path), memoryText(memory), INSTRUCTION_FILE_NAMES)), ...(options.session ? { sessionId: options.session } : {}), guard: guardCommandFor(path, cwd), command: cli.command, args: cli.args, env: cli.env, ...(cli.model ? { model: cli.model } : {}), ...(cli.models?.length ? { models: cli.models.map((m) => ({ id: m.id, name: m.name, ...(m.badge ? { badge: m.badge } : {}), ...(m.blurb ? { blurb: m.blurb } : {}) })) } : {}), ...(model.value.efforts ? { efforts: model.value.efforts } : {}) };
  const switcher = cli ? undefined : switcherFor(file.value, model.value.name, io.env, path, model.value.window, model.value.efforts);
  const engine: AgentEngine = cli
    ? cli.adapter === "codex" ? new CodexEngine(program!) : new StreamEngine(program!)
    : new Engine({
        ...common,
        sessionId,
        retry: retryFrom(io.env),
        attachments: attachmentsDir(io.env),
        ...(model.value.vision !== undefined ? { vision: model.value.vision } : {}),
        ...(!switcher && model.value.efforts?.length ? { efforts: model.value.efforts } : {}),
        tools: activeTools(new PluginState(pluginStatePath(io.env))),
        backend: backendFor(new TerminalState(terminalStatePath(io.env)), file.value?.terminal),
        ...(extras.recall && kind !== "chat" ? { recall: extras.recall } : {}),
        provider: withFallback(providerFor(model.value.api, provider!, model.value.window, model.value.signIn ? credentialsFor(model.value.signIn, io.env) : undefined, model.value.pdf), model.value.name, file.value, io.env, path, emit),
        store: new FileSessionStore(kind === "chat" ? chatSessionsDir(io.env) : sessionsDir(io.env)),
        secrets: [...Object.values(file.value?.models ?? {}).map((m) => m.apiKey), file.value?.webProxy?.token].filter((k): k is string => !!k),
        persona: leanSoul(brain),
        ...(referenceFor(brain) ? { reference: referenceFor(brain)! } : {}),
        ...(switcher ? { switcher } : {}),
        kind,
        model: { id: model.value.name, name: shown ?? provider?.model ?? model.value.name, ...(file.value?.models[model.value.name] ? { blurb: describeEntry(file.value.models[model.value.name]!) } : {}), ...(file.value?.models[model.value.name]?.display?.brand ? { brand: file.value.models[model.value.name]!.display!.brand! } : {}), ...(file.value?.models[model.value.name] && catalogOf(model.value.name, file.value.models[model.value.name]!) ? { catalog: catalogOf(model.value.name, file.value.models[model.value.name]!)! } : {}) },
        ...(options.sandboxed ? { sandboxed: true } : {}),
        // A chat has no project: no helpers, no rules or hooks written for projects, no skills, no project instructions, no checkpoints, no outside tool servers.
        ...(kind === "chat" ? {} : {
          agents: loadAgents([join(dirname(path), "agents"), ...projectDirs(cwd).map((d) => join(d, ".navvied", "agents"))]),
          ...(rulesFor(file.value?.permissions, cwd) ? { rules: rulesFor(file.value?.permissions, cwd)! } : {}),
          ...(activeHooks(new PluginState(pluginStatePath(io.env)), file.value?.hooks) ? { hooks: commandHooks(activeHooks(new PluginState(pluginStatePath(io.env)), file.value?.hooks)!, cwd, () => sessionId) } : {}),
          skills: () => activeSkills(new PluginState(pluginStatePath(io.env)), { user: join(dirname(path), "skills"), project: projectDirs(cwd).map((d) => join(d, ".navvied", "skills")) }),
        }),
        ...(io.env.NAVVIED_SEARCH_URL ? { search: { url: io.env.NAVVIED_SEARCH_URL } } : {}),
        ...(file.value?.webProxy ? { webProxy: file.value.webProxy } : {}),
        ...(io.env.NAVVIED_ALLOW_PRIVATE_NETWORK === "1" ? { allowPrivateNetwork: true } : {}),
        ...(kind === "chat" ? {} : { instructions: () => loadInstructions(cwd, dirname(path), memoryText(memory), INSTRUCTION_FILE_NAMES) }),
        memory,
        ...(kind === "chat" ? {} : { checkpoints: new Checkpoints({ dir: checkpointsDir(io.env), session: sessionId }) }),
        ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
      });
  if (engine instanceof Engine && file.value?.mcp && kind === "agent") {
    const off = new PluginState(pluginStatePath(io.env)).disabled();
    const servers = Object.fromEntries(Object.entries(file.value.mcp).filter(([name]) => !off.has(mcpId(name))).map(([name, e]) => [name, { ...e, cwd: e.cwd ?? cwd }]));
    engine.loadTools(connectMcp(servers, model.value.window <= SMALL_WINDOW, engine.closing));
  }
  const notes = instructionFiles(cwd, dirname(path), INSTRUCTION_FILE_NAMES);
  return { ok: true, value: { engine, entry: model.value.name, modelName: shown || provider?.model || cli?.model || model.value.name, where: describeModel(cli, provider?.baseUrl), cwd, ...(cli ? { program: true as const } : { tools: defaultTools().map((t) => t.name) }), notes } };
}
