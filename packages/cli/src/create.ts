import { leanSoul, referenceFor, soulFor, type Brain } from "./soul.ts";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { secretNames, ChatCompletionsProvider, type SkillInfo, SkillBook, type ComputerHelper, type MediaShelf, type ToolContext, loadAgents, Rules, hasRules, homeFrom, nativePaths, parseRules, type RuleSet, commandHooks, memoryText, noteTexts, connectMcp, OAuthStore, loadSkills, projectDirs, type ModelSwitch, Checkpoints, Engine, FileSessionStore, MessagesApiProvider, OllamaProvider, ResponsesApiProvider, defaultTools, instructionFiles, loadInstructions, agentDirs, type AgentEngine, type ChatCompletionsConfig, type Credentials, type Provider, FallbackProvider, type FallbackLink, type RetryOptions } from "@navvied/engine";
import { randomUUID } from "node:crypto";
import { CodexEngine, StreamEngine } from "@navvied/stream-engine";
import type { Effort, EngineEvent, ModelInfo, Result } from "@navvied/protocol";
import type { Options } from "./args.ts";
import { toolSwitch } from "./tools-info.ts";
import { TerminalState, backendFor } from "./terminal.ts";
import { SandboxState, sandboxSetting } from "./sandbox.ts";
import { accountPath, attachmentsDir, chatFilesDir, chatSessionsDir, checkpointsDir, configPath, mcpAuthPath, jobsDir, localDir, toolFilesDir, schedulesPath, skillLedgerPath, skillTrustPath, loadConfig, searchIndexPath, pluginStatePath, terminalStatePath, sandboxStatePath, a2aTokensPath, devicesPath, resolveModel, sessionsDir, type ConfigFile, type ModelEntry, type ResolvedModel, LOCAL_HOSTS } from "./config.ts";
import { Conversations } from "./conversations.ts";
import { scheduleFor } from "./schedule-tool.ts";
import type { JobRunner } from "./schedule-run.ts";
import type { IO } from "./io.ts";
import { memoryPathsFor } from "./memory-ui.ts";
import { meaningFor, notesByMeaning, vectorsFor } from "./meaning.ts";
import { DEFAULT_SERVER, catalogOf, readAccount } from "./account.ts";
import { INSTRUCTION_FILE_NAMES, PROVIDERS, knownEffort } from "./presets.ts";
import { adcCredentials } from "./adc.ts";
import { LiveProvider } from "./live-provider.ts";
import { savedSecrets } from "./providers.ts";
import { credentialsFor } from "./logins.ts";
import { mediaFor } from "./media-setup.ts";
import { localVision } from "./media-vision.ts";
import { peerBook } from "./a2a-peers.ts";
import { PluginState, SkillTrust, heldSkillsNote, activeHooks, activePacks, activeSkills, mcpId, packServers, pluginPlaces, projectSkillDirs, readPacks, withPackHooks } from "./plugins.ts";

/** `where` says in plain words how the model is reached, for the welcome screen. */
/** Search: the person's own server when there is one; otherwise the keyless ladder, whose last public rung is navvied's own search, asked with this computer's account when it has one. Not in a session that reaches the web through the service. */
export function searchFor(env: Record<string, string | undefined>, options: { config?: string; sandboxed?: boolean }, proxied: boolean): NonNullable<ToolContext["search"]> {
  const order = env.NAVVIED_SEARCH_ORDER?.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    ...(env.NAVVIED_SEARCH_URL ? { url: env.NAVVIED_SEARCH_URL } : {}),
    ...(order?.length ? { order } : {}),
    ...(proxied || options.sandboxed ? {} : { navvied: () => { const account = readAccount(accountPath(env, options.config)); return { server: account?.server ?? env.NAVVIED_SERVER ?? DEFAULT_SERVER, ...(account ? { token: account.token } : {}) }; } }),
  };
}

/** The model that looks at pictures for the tools that return words: the one the configuration names, else the conversation's own model when it sees pictures. */
export function visionFor(file: ConfigFile | null, model: ResolvedModel, env: Record<string, string | undefined>, path: string): Provider | undefined {
  const v = file?.media?.vision;
  if (v && "local" in v) return localVision(v.local, join(localDir(env), "vision-server.json"));
  const named = v?.model;
  if (named) {
    const other = resolved(named, file, env, path);
    return other.ok && other.value.provider && other.value.vision !== false ? serviceOf(named, other.value, file, env, path) : undefined;
  }
  return model.vision === true && model.provider ? serviceOf(model.name, model, file, env, path) : undefined;
}

export interface Created { engine: AgentEngine; /** The name of the model in the configuration. */ entry: string; modelName: string; where: string; cwd: string; tools?: string[]; notes: string[]; /** What was held back among the project skills and why, in words; nothing when all are in use. */ heldSkills?: () => string | undefined; /** The model is reached through a program the person is signed in to, which keeps its own sessions. */ program?: true }

/** What signs the requests of a model that has no key: the saved sign-in of a program account, or a credential file's access token. */
const credentialsOf = (m: { signIn?: { provider: string; file?: string }; adc?: { file: string; tokenUri: string; scope: string } }, env: Record<string, string | undefined>): Credentials | undefined =>
  m.signIn ? credentialsFor(m.signIn, env) : m.adc ? adcCredentials(m.adc) : undefined;

/**
 * The service of a resolved model. A model made from a provider is resolved again at each request (see live-provider.ts); any other is fixed.
 */
function serviceOf(name: string, now: ResolvedModel, file: ConfigFile | null, env: Record<string, string | undefined>, path: string): Provider {
  const build = (m: ResolvedModel): Provider => providerFor(m.api, m.provider!, m.window, credentialsOf(m, env), m.pdf);
  const made = file?.models[name];
  if (!made?.provider && !made?.endpoint && !made?.local) return build(now);
  return new LiveProvider(() => { const f = loadConfig(path, env); return f.ok ? resolveModel(name, f.value, env, path) : { ok: false, error: f.error }; }, build, now);
}

const providerFor = (api: "chat" | "messages" | "responses" | "ollama" | undefined, cfg: ChatCompletionsConfig, window: number, credentials?: Credentials, pdf?: boolean): Provider =>
  api === "messages" ? new MessagesApiProvider({ ...(pdf ? { readsPdf: true } : {}), baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...(cfg.headers ? { headers: cfg.headers } : {}), ...(credentials ? { credentials } : {}) })
  : api === "responses" ? new ResponsesApiProvider({ ...(pdf ? { readsPdf: true } : {}), baseUrl: cfg.baseUrl, model: cfg.model, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}), ...(cfg.headers ? { headers: cfg.headers } : {}), ...(credentials ? { credentials } : {}) })
  : api === "ollama" ? new OllamaProvider({ baseUrl: cfg.baseUrl, model: cfg.model, contextTokens: window, ...(cfg.headers ? { headers: cfg.headers } : {}) })
  : new ChatCompletionsProvider(cfg, credentials);

/**
 * The permission rules for a project: the person's own (allow, ask, deny) plus, when the project has a `.navvied/permissions.json`,
 * the ones it can only make stricter (ask, deny). A project can never allow anything: it is not the person's own word.
 */
function rulesFor(own: RuleSet | undefined, cwd: string, env: Record<string, string | undefined>): Rules | undefined {
  let project: RuleSet = { allow: [], ask: [], deny: [] };
  try { project = parseRules(JSON.parse(readFileSync(join(cwd, ".navvied", "permissions.json"), "utf8"))); } catch { /* none, or not readable */ }
  const set: RuleSet = { allow: own?.allow ?? [], ask: [...(own?.ask ?? []), ...project.ask], deny: [...(own?.deny ?? []), ...project.deny] };
  return hasRules(set) ? new Rules(set, cwd, { ...nativePaths, home: homeFrom(env) }) : undefined;
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
    chain.push({ name: file?.models[other]?.display?.name ?? other, provider: serviceOf(other, next.value, file, env, path) });
  }
  return chain.length > 1 ? new FallbackProvider(chain, (msg) => emit({ ev: "notice", msg }), retry) : first;
}


/** In words, how a configured model is reached. */
/** What must never be shown in any output: the keys of the models and of the endpoints, the keys and secret fields saved for providers, and the web proxy's token. */
export const secretsOf = (file: ConfigFile | null): string[] =>
  [...Object.values(file?.models ?? {}).map((m) => m.apiKey), ...Object.values(file?.endpoints ?? {}).map((e) => e.key), ...savedSecrets(PROVIDERS, file?.providers), file?.webProxy?.token].filter((k): k is string => !!k);

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
const brainFor = (name: string, model: string | undefined, small: boolean, shown?: string): Brain => ({ label: `"${shown ?? model ?? name}"`, tools: TOOL_NAMES(), small });

/** The models this engine can switch to without starting over: the ones it can run itself. A program is a different kind of engine. */
/** The model as the configuration says, with the effort levels its service documents when the configuration lists none (and says nothing against). */
export function resolved(choice: string | undefined, file: ConfigFile | null, env: Record<string, string | undefined>, path: string): ReturnType<typeof resolveModel> {
  const r = resolveModel(choice, file, env, path);
  if (!r.ok || !r.value.provider || r.value.cli || r.value.efforts || r.value.provider.reasoning === "none") return r;
  const known = knownEffort({ baseUrl: r.value.provider.baseUrl, model: r.value.provider.model, ...(r.value.signIn ? { signIn: r.value.signIn } : {}) });
  if (!known) return r;
  return { ok: true, value: { ...r.value, efforts: known.efforts, provider: { ...r.value.provider, ...(known.field ? { effortField: known.field } : {}) } } };
}

/** One entry of the model list as a page is told of it. */
export const modelInfoOf = (id: string, e: ModelEntry): ModelInfo => ({ id, name: e.display?.name ?? e.model ?? id, blurb: e.display?.blurb ?? describeEntry(e), ...(e.display?.brand ? { brand: e.display.brand } : {}), ...(e.display?.badge ? { badge: e.display.badge } : {}), ...(e.display?.locked ? { locked: true } : {}), ...(catalogOf(id, e) ? { catalog: catalogOf(id, e)! } : {}), ...(e.local?.tools !== undefined ? { tools: e.local.tools } : {}) });

function switcherFor(file: ConfigFile | null, current: string, env: Record<string, string | undefined>, path: string, window: number, efforts: Effort[] | undefined): ModelSwitch | undefined {
  const own = Object.entries(file?.models ?? {}).filter(([, e]) => !e.command);
  if (own.length < 2) return undefined;
  return {
    models: own.map(([id, e]) => modelInfoOf(id, e)),
    current,
    ...(efforts?.length ? { efforts } : {}),
    use(id) {
      if (file?.models[id]?.display?.locked) return { error: `${file.models[id]!.display!.name ?? id} is not available yet.` };
      const next = resolved(id, file, env, path);
      if (!next.ok) return { error: next.error };
      if (next.value.cli || !next.value.provider) return { error: "That model runs in a different program, so it needs a new conversation." };
      return {
        provider: serviceOf(id, next.value, file, env, path), window: next.value.window, small: next.value.small,
        ...(next.value.efforts ? { efforts: next.value.efforts } : {}),
        ...(next.value.vision !== undefined ? { vision: next.value.vision } : {}),
        persona: leanSoul(brainFor(id, next.value.provider.model, next.value.small, file?.models[id]?.display?.name)),
        ...(referenceFor(brainFor(id, next.value.provider.model, next.value.small, file?.models[id]?.display?.name)) ? { reference: referenceFor(brainFor(id, next.value.provider.model, next.value.small, file?.models[id]?.display?.name))! } : {}),
      };
    },
  };
}

/** What the hub gives an engine that it cannot make for itself: the person's earlier conversations. */
export interface EngineExtras { /** A command that ended wakes the conversation (a host that shows it live says so). */ wake?: boolean; /** Whether a person is looking at this conversation (a window or a terminal is attached): only then is a question waited for. */ attended?: () => boolean; /** Where conversations are kept and found, when the host keeps the record of what was said itself (it follows the events with a journal of its own); without it the engine keeps and finds them. */ conversations?: Conversations; /** The conversation of an agent that is not the person's (see a2a-server.ts): no other agents to ask, no memory, no notes or standing instructions of the person, no skills made, files held to the folder. */ inbound?: true; /** What drives this computer's screen, when computer use is on. */ computer?: ComputerHelper | (() => ComputerHelper | undefined); /** Where the pictures, sounds and videos the steps make are kept for a page to fetch. */ shelf?: MediaShelf; /** Said after the Schedule tool changed the tasks of this computer. */ schedulesChanged?: () => void; /** The runs of the hub, so a task the tool starts or stops is the same one its timer and its screen know. */ jobs?: () => JobRunner; /** What was said in this conversation before it came to a program from another model: the program is told it with its instructions, and answers as one that was there. */ earlier?: string }

/** What an agent that is not the person's may not use even when the mode would allow it: it must not write to the person's memory or make skills. */
const INBOUND_OFF = new Set(["Remember", "SkillManage", "Recall"]);

export function createEngine(options: Options, io: IO, say: (e: EngineEvent) => void, extras: EngineExtras = {}): Result<Created> {
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
  // What is said in a conversation is kept and found the same way in every front-end. A host that follows the events itself brings its own book; an agent that is not the person's keeps nothing of theirs.
  const book = extras.conversations ?? new Conversations(kind, io.env, () => basename(cwd), options.config);
  const journal = extras.conversations || extras.inbound ? undefined : book.journal();
  const emit = journal ? (e: EngineEvent): void => { journal.record(e); say(e); } : say;
  const memory = memoryPathsFor(cwd, path);
  // Notes are found by meaning too only when the person set up a server for it; an inbound agent has no notes and never asks one.
  const meaning = kind === "chat" || extras.inbound ? undefined : meaningFor(file.value?.memory?.embeddings, io.env, vectorsFor(searchIndexPath(io.env)));
  const byMeaning = meaning && notesByMeaning(meaning, () => noteTexts(memory));
  const standing = (request?: string): string | undefined => { const text = memoryText(memory, request, byMeaning?.like()); const why = text ? byMeaning?.notice() : undefined; return why ? `${text}\n(${why})` : text; };
  const common = { cwd, window: model.value.window, emit };
  const { cli, provider } = model.value;
  const shown = file.value?.models[model.value.name]?.display?.name;
  const brain: Brain = { label: cli ? (cli.adapter === "codex" ? "the model of the user's ChatGPT plan" : "the model of the program the user is signed in to") : `"${shown ?? provider?.model ?? model.value.name}"`, ...(cli ? { program: true, ownTools: TOOL_NAMES() } : { tools: TOOL_NAMES(), small: model.value.small }), ...(kind === "chat" ? { chat: true } : {}) };
  const program = cli && { ...common, ...(rulesFor(file.value?.permissions, cwd, io.env) ? { rules: rulesFor(file.value?.permissions, cwd, io.env)! } : {}), entry: { id: model.value.name, name: shown ?? model.value.name }, persona: `${soulFor(brain, loadInstructions(cwd, dirname(path), memoryText(memory), INSTRUCTION_FILE_NAMES))}${extras.earlier ? `\n\n${extras.earlier}` : ""}`, ...(options.session ? { sessionId: options.session } : {}), guard: guardCommandFor(path, cwd), command: cli.command, args: cli.args, env: cli.env, ...(cli.model ? { model: cli.model } : {}), ...(cli.models?.length ? { models: cli.models.map((m) => ({ id: m.id, name: m.name, ...(m.badge ? { badge: m.badge } : {}), ...(m.blurb ? { blurb: m.blurb } : {}) })) } : {}), ...(model.value.efforts ? { efforts: model.value.efforts } : {}) };
  // What a command the model runs and a hook may inherit: the same, less every secret.
  const scrub = { drop: secretNames(io.env), keep: [...(file.value?.terminal?.env ?? []), ...(io.env.NAVVIED_TERMINAL_ENV?.split(",").map((n) => n.trim()).filter(Boolean) ?? [])] };
  const pluginState = new PluginState(pluginStatePath(io.env));
  const skillTrust = new SkillTrust(skillTrustPath(io.env));
  const places = pluginPlaces(path);
  const live = kind === "chat" || cli ? [] : activePacks(pluginState, skillTrust, readPacks(dirname(path), places.lock, cwd));
  const hookConfig = withPackHooks(activeHooks(pluginState, file.value?.hooks), live);
  const switcher = cli ? undefined : switcherFor(file.value, model.value.name, io.env, path, model.value.window, model.value.efforts);
  const skillsNow = (): SkillInfo[] => activeSkills(pluginState, { user: join(dirname(path), "skills"), project: projectSkillDirs(cwd), plugins: live.map((p) => join(p.dir, "skills")) }, skillTrust);
  const engine: AgentEngine = cli
    ? cli.adapter === "codex" ? new CodexEngine(program!) : new StreamEngine(program!)
    : new Engine({
        ...common,
        small: model.value.small,
        sessionId,
        retry: retryFrom(io.env),
        attachments: attachmentsDir(io.env),
        ...(model.value.vision !== undefined ? { vision: model.value.vision } : {}),
        ...(!switcher && model.value.efforts?.length ? { efforts: model.value.efforts } : {}),
        ...(io.env.NAVVIED_CODE_OFFER === "always" ? { codeOffer: { mode: "always" as const } } : {}),
        toolOn: extras.inbound ? ((on) => (name: string) => on(name) && !INBOUND_OFF.has(name))(toolSwitch(new PluginState(pluginStatePath(io.env)))) : toolSwitch(new PluginState(pluginStatePath(io.env))),
        ...(extras.inbound ? { outside: true as const } : file.value?.a2a && Object.keys(file.value.a2a.peers).length ? { peers: peerBook(file.value.a2a.peers, io.env, io.fetch) } : {}),
        backend: backendFor(new TerminalState(terminalStatePath(io.env)), file.value?.terminal),
        env: scrub,
        // The files of this program that hold keys are hidden from a confined command; the setting is read again for each command.
        confinement: { setting: () => sandboxSetting(new SandboxState(sandboxStatePath(io.env)), file.value?.sandbox), hide: () => [path, accountPath(io.env, options.config), mcpAuthPath(io.env, options.config), a2aTokensPath(io.env), devicesPath(io.env)] },
        jobsDir: jobsDir(io.env),
        ...(extras.wake ? { wake: true } : {}),
        ...(extras.inbound ? {} : { recall: book.recall(() => engine.sessionId) }),
        schedule: scheduleFor({ env: io.env, file: schedulesPath(io.env), webProxy: file.value?.webProxy, cwd, chat: kind === "chat", changed: extras.schedulesChanged, runner: extras.jobs }),
        toolFolder: (tool) => join(toolFilesDir(io.env), tool),
        ...(extras.computer ? { computer: extras.computer } : {}),
        ...(extras.shelf ? { shelf: extras.shelf } : {}),
        ...(extras.attended ? { attended: extras.attended } : {}),
        ...(Number(io.env.NAVVIED_ASK_WAIT_SECONDS) >= 0 && io.env.NAVVIED_ASK_WAIT_SECONDS ? { askWaitMs: Number(io.env.NAVVIED_ASK_WAIT_SECONDS) * 1000 } : {}),
        provider: withFallback(serviceOf(model.value.name, model.value, file.value, io.env, path), model.value.name, file.value, io.env, path, emit),
        store: new FileSessionStore(kind === "chat" ? chatSessionsDir(io.env) : sessionsDir(io.env)),
        secrets: secretsOf(file.value),
        persona: leanSoul(brain),
        ...(referenceFor(brain) ? { reference: referenceFor(brain)! } : {}),
        ...(switcher ? { switcher } : {}),
        kind,
        model: { id: model.value.name, name: shown ?? provider?.model ?? model.value.name, ...(file.value?.models[model.value.name] ? { blurb: describeEntry(file.value.models[model.value.name]!) } : {}), ...(file.value?.models[model.value.name]?.display?.brand ? { brand: file.value.models[model.value.name]!.display!.brand! } : {}), ...(file.value?.models[model.value.name] && catalogOf(model.value.name, file.value.models[model.value.name]!) ? { catalog: catalogOf(model.value.name, file.value.models[model.value.name]!)! } : {}) },
        ...(options.sandboxed ? { sandboxed: true } : {}),
        // A chat has no project: no helpers, no rules or hooks written for projects, no skills, no project instructions, no checkpoints, no outside tool servers.
        ...(kind === "chat" ? {} : {
          agents: loadAgents([...live.map((p) => join(p.dir, "agents")), ...agentDirs(io.env.HOME ?? io.env.USERPROFILE ?? homedir(), dirname(path), projectDirs(cwd))]),
          ...(rulesFor(file.value?.permissions, cwd, io.env) ? { rules: rulesFor(file.value?.permissions, cwd, io.env)! } : {}),
        home: homeFrom(io.env),
          ...(hookConfig ? { hooks: commandHooks(hookConfig, cwd, () => sessionId, scrub) } : {}),
          skills: skillsNow,
          skillBook: new SkillBook({ user: join(dirname(path), "skills"), project: join(cwd, ".navvied", "skills"), ledger: skillLedgerPath(io.env) }, Date.now, (s) => skillTrust.answer(s, true)),
          skillApproval: () => file.value?.skills?.approval ?? "auto",
        }),
        search: searchFor(io.env, options, !!file.value?.webProxy),
        ...(file.value?.webProxy ? { webProxy: file.value.webProxy } : {}),
        media: mediaFor(io.env, file.value?.media, { ...(options.config ? { config: options.config } : {}), ...(options.sandboxed ? { sandboxed: true } : {}), ...(file.value?.webProxy ? { webProxy: file.value.webProxy } : {}) }, visionFor(file.value, model.value, io.env, path)),
        ...(io.env.NAVVIED_ALLOW_PRIVATE_NETWORK === "1" ? { allowPrivateNetwork: true } : {}),
        ...(kind === "chat" ? {} : { instructions: (request) => (extras.inbound ? loadInstructions(cwd, undefined, undefined, INSTRUCTION_FILE_NAMES) : loadInstructions(cwd, dirname(path), standing(request?.userText), INSTRUCTION_FILE_NAMES)) }),
        ...(byMeaning ? { prepare: byMeaning.prepare } : {}),
        ...(kind === "chat" || extras.inbound ? {} : { memory, ...(file.value?.memory?.extract ? { memoryExtract: file.value.memory.extract } : {}) }),
        ...(kind === "chat" ? {} : { checkpoints: new Checkpoints({ dir: checkpointsDir(io.env), session: sessionId }) }),
        ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
        ...(file.value?.applyPatch ? { applyPatch: file.value.applyPatch } : {}),
      });
  if (engine instanceof Engine && (file.value?.mcp || live.some((p) => Object.keys(p.mcp).length)) && kind === "agent") {
    const off = new PluginState(pluginStatePath(io.env)).disabled();
    const servers = { ...Object.fromEntries(Object.entries(file.value?.mcp ?? {}).filter(([name]) => !off.has(mcpId(name))).map(([name, e]) => [name, { ...e, cwd: e.cwd ?? cwd }])), ...Object.fromEntries(Object.entries(packServers(live)).map(([name, e]) => [name, { ...e, cwd: e.cwd ?? cwd }])) };
    engine.loadTools(connectMcp(servers, model.value.small, engine.closing, { window: model.value.window, store: new OAuthStore(mcpAuthPath(io.env, options.config)), host: engine.mcpHost }));
  }
  const notes = instructionFiles(cwd, dirname(path), INSTRUCTION_FILE_NAMES);
  return { ok: true, value: { engine, entry: model.value.name, modelName: shown || provider?.model || cli?.model || model.value.name, where: describeModel(cli, provider?.baseUrl), cwd, ...(kind === "chat" || cli ? {} : { heldSkills: () => heldSkillsNote(skillsNow(), skillTrust) }), ...(cli ? { program: true as const } : { tools: defaultTools().map((t) => t.name) }), notes } };
}
