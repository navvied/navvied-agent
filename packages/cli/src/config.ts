import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expandEndpointModel, modelNames, endpointModel, type EndpointRecord } from "./endpoints.ts";
import { expandLocalModel } from "./local-entry.ts";
import { PROVIDERS } from "./presets.ts";
import { expandModel, type SavedProvider } from "./providers.ts";
import { dirname, posix, win32 } from "node:path";
import { hasRules, parseRules, type ChatCompletionsConfig, type HookConfig, type HookEvent, type RuleSet } from "@navvied/engine";
import { EFFORTS, isBaseAddress, type Effort, type Result } from "@navvied/protocol";
import { DEFAULT_SERVER, GUEST_PREFIX, HOSTED_PREFIX, guestEntries, hostedEntries, readAccount, readHostedModels } from "./account.ts";

export type Env = Record<string, string | undefined>;

/**
 * A model is either an HTTP endpoint (`baseUrl` + `model`) driven by navvied's own engine, or an external command-line
 * agent (`command`) that the user has already signed in to — its login stays with that program.
 */
export interface ModelEntry {
  baseUrl?: string;
  /** The kind of HTTP API at `baseUrl`: `chat` (chat completions, the default), `messages` (the messages API) or `ollama` (the native API of Ollama, which can set the model's memory). */
  api?: "chat" | "messages" | "responses" | "ollama";
  model?: string;
  command?: string;
  /** Use the sign-in a program on this computer already made (`claude` or `chatgpt`), with navvied's own tools. `file` says where it is saved when it is not the usual place. */
  signIn?: { provider: string; file?: string };
  /**
   * A model made from a provider the person gave a key (see providers.ts) holds no key and no address: only which provider, and what was chosen
   * (the route its model list gave it, the session id it asked for, the credential file's path). Everything else is read from `providers` whenever
   * the model is resolved, so removing the provider or saving a new key reaches every model made from it.
   */
  provider?: string;
  /** A model of an endpoint the person made (see endpoints.ts): holds no key and no address either; both are read from `endpoints` when the model is resolved. */
  endpoint?: string;
  /** A model on this computer, run by the program's own model server while it is running: the address is the one of that run, read when the model is used. */
  /** A model of this computer's own server; `tools` is whether its chat template handles tools, when the file says. */
  local?: { repo: string; file: string; window: number; tools?: boolean };
  route?: { api: "chat" | "responses" | "messages"; base: string };
  session?: string;
  credential?: string;
  /** The access token of every request comes from a credential file on this computer that stays where it is: only its path is kept here (see adc.ts). */
  adc?: { file: string; tokenUri: string; scope: string };
  /** How to talk to the program at `command`: `stream` (the default) or `codex`. */
  adapter?: "stream" | "codex";
  args?: string[];
  env?: Record<string, string>;
  apiKey?: string;
  /** Name of an environment variable that holds the key (preferred over `apiKey`). */
  apiKeyEnv?: string;
  window?: number;
  /** The model can see pictures (absent: not known). */
  vision?: boolean;
  /** The service reads a PDF given as a file (messages API only). */
  pdf?: boolean;
  /** `none`: never send a reasoning-effort field. */
  reasoning?: "effort" | "none";
  headers?: Record<string, string>;
  /** For a program at `command`: the models it can be told to use. `id` is what it is given after its model flag; "default" leaves the choice to it. */
  models?: { id: string; name: string; badge?: string; blurb?: string }[];
  /** The reasoning effort levels the model accepts. A model entry that sets `reasoning: "effort"` without this accepts low, medium and high. */
  efforts?: Effort[];
  /** The id this entry has in navvied.com's own catalogue, for the entries that run one of its models (written by sign-in and by the first-run choice of the free models). */
  catalog?: string;
  /** How the model is shown in a list, when the person should not see the real model name (a hosted service with its own brands). */
  display?: { name?: string; brand?: string; badge?: string; blurb?: string; /** Shown but not usable now, such as a model that needs a plan. */ locked?: boolean };
}
/** A program that gives the agent more tools (an MCP server): the command that starts it. */
export interface McpEntry { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; /** A server reached over the web instead of a program started here. */ url?: string; headers?: Record<string, string> }
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "SessionStart", "PreCompact"];

/** Where the Bash tool may run its commands besides this computer. The host and the image are set here, never from a page. */
/** `env`: names of environment variables a command may keep although they look like secrets (the keys navvied itself uses are never passed on). */
export interface TerminalConfig { docker?: { image?: string }; ssh?: { host: string; user?: string; dir?: string }; env?: string[] }
export interface ConfigFile { default?: string; terminal?: TerminalConfig; /** Folders an agent may be started in, besides the one the program starts in and the ones worked in lately. Added here, never from a page. */ folders?: string[]; /** `false`: do not use the free models of navvied.com without an account (the default is to use them, as listed by the server). */ guestModels?: boolean; /** `list` (default): every step is one line, a failure or a change shows more. `fold`: steps that went well are folded away. `all`: everything every step printed. */ steps?: "list" | "fold" | "all"; /** Whether the model is offered the `apply_patch` tool: `auto` (default: when its window is not small), `on` or `off`. */ applyPatch?: "auto" | "on" | "off"; /** Models to use, in this order, when the one chosen cannot be reached (names of entries in `models`). */ fallback?: string[]; theme?: string; accent?: string; autoUpdate?: boolean; /** Where a hosted session reaches the web, and the token to ask with. Written by the service that runs the session. */ webProxy?: { url: string; token: string }; models: Record<string, ModelEntry>; /** What this computer keeps for the providers a person has a key of their own for (see providers.ts). Never sent anywhere. */ providers?: Record<string, SavedProvider>; /** The servers of the person's own that were added from a page (see endpoints.ts). Never sent anywhere, keys included. */ endpoints?: Record<string, EndpointRecord>; mcp?: Record<string, McpEntry>; hooks?: HookConfig; /** `false` keeps this computer's conversations off the account (default: they are kept there while signed in) */ syncConversations?: boolean; /** allow / ask / deny rules; see docs/CLI.md */ permissions?: RuleSet; /** `approval`: a skill the agent makes or changes waits for the person (`ask`) or is made and can be undone (`auto`, the default). `trust: "confirm"`: a skill that comes with a project is not offered to the model until the person accepts it. */ skills?: { approval?: "ask" | "auto"; trust?: "confirm" }; }

export interface ResolvedModel {
  name: string;
  window: number;
  provider?: ChatCompletionsConfig;
  /** Which HTTP API `provider` speaks. */
  api?: "chat" | "messages" | "responses" | "ollama";
  /** The saved sign-in this model is reached with, instead of a key. */
  signIn?: { provider: string; file?: string };
  /** The access token comes from a credential file instead of a key. */
  adc?: { file: string; tokenUri: string; scope: string };
  cli?: { command: string; args: string[]; model?: string; env: Record<string, string>; adapter?: "stream" | "codex"; models?: ModelEntry["models"] };
  /** The effort levels it accepts; none when it has no such setting. */
  efforts?: Effort[];
  vision?: boolean;
  pdf?: boolean;
}

type Platform = NodeJS.Platform;
const joiner = (platform: Platform) => (platform === "win32" ? win32.join : posix.join);
const home = (env: Env, platform: Platform): string => env.HOME ?? (platform === "win32" ? env.USERPROFILE : undefined) ?? "";

export const configPath = (env: Env, flag?: string, platform: Platform = process.platform): string => {
  const join = joiner(platform);
  const base = env.XDG_CONFIG_HOME ?? (platform === "win32" ? env.APPDATA ?? join(home(env, platform), "AppData", "Roaming") : join(home(env, platform), ".config"));
  return flag ?? env.NAVVIED_CONFIG ?? join(base, "navvied", "config.json");
};

const stateDir = (env: Env, platform: Platform): string => {
  const join = joiner(platform);
  const base = env.XDG_STATE_HOME ?? (platform === "win32" ? env.LOCALAPPDATA ?? join(home(env, platform), "AppData", "Local") : join(home(env, platform), ".local", "state"));
  return join(base, "navvied");
};
/** Where local models and the runtime that runs them are kept: in navvied's own state folder, or where `NAVVIED_LOCAL_DIR` says (a bigger disk). */
export const localDir = (env: Env, platform: Platform = process.platform): string => env.NAVVIED_LOCAL_DIR || joiner(platform)(stateDir(env, platform), "local");
export const updateStampPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "update-check");
/** What was said in each conversation, whatever kind of engine took part, so every window can list and open it. */
export const journalDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "journal");
/** The full-text index over what was said in the saved conversations. */
export const searchIndexPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "search.sqlite");
/** The tasks the person scheduled, and where what each one produced is kept. */
/** Where commands run (this computer, a container, another machine) and how many times each tool was used, kept in the computer's own state. */
export const terminalStatePath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "terminal.json");
/** Where background commands keep their whole output and the record a restart finds them by. */
export const jobsDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "jobs");
export const draftsPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "drafts.json");
export const toolUsagePath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "tool-usage.json");
export const schedulesPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "schedules.json");
export const scheduledDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "scheduled");
/** Where the files attached to conversations are kept, one folder per session. */
export const attachmentsDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "attachments");
export const sessionsDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "sessions");
/**
 * A chat keeps everything of its own, apart from the projects: the folder it works in (and nowhere else), its saved conversations,
 * the record of what was said, and the search index over them.
 */
const chatDir = (env: Env, platform: Platform): string => joiner(platform)(stateDir(env, platform), "chat");
export const chatFilesDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(chatDir(env, platform), "files");
export const chatSessionsDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(chatDir(env, platform), "sessions");
export const chatJournalDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(chatDir(env, platform), "journal");
export const chatSearchIndexPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(chatDir(env, platform), "search.sqlite");
/** The account this computer is signed in to lives next to the configuration file; what the server last said it offers is kept with the program's own state. */
export const accountPath = (env: Env, flag?: string, platform: Platform = process.platform): string => joiner(platform)(dirnameOf(configPath(env, flag, platform), platform), "account.json");
/** The free models of navvied.com for a computer without an account, as last listed by the server. */
export const guestModelsPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "guest-models.json");
/** What the person accepted among the skills that come with projects, and the record of every change the agent made to a skill. */
export const skillTrustPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "skill-trust.json");
export const skillLedgerPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "skills-ledger.jsonl");
/** What the person switched off among skills, tool servers and hooks. */
export const pluginStatePath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "plugins.json");
/** The folders worked in lately, so a page can offer them. */
export const foldersPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "folders.json");
export const hostedModelsPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "hosted-models.json");
const dirnameOf = (path: string, platform: Platform): string => (platform === "win32" ? win32.dirname(path) : posix.dirname(path));
export const devicesPath = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "devices.json");
export const checkpointsDir = (env: Env, platform: Platform = process.platform): string => joiner(platform)(stateDir(env, platform), "checkpoints");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks one model entry as it would be read from the file, and keeps only the fields that belong. */
export function parseModelEntry(name: string, raw: unknown): Result<ModelEntry> { return entry(name, raw); }

function entry(name: string, raw: unknown): Result<ModelEntry> {
  if (!isObj(raw)) return { ok: false, error: `model "${name}" must be an object` };
  const external = raw.command !== undefined;
  if (external) {
    if (typeof raw.command !== "string" || !raw.command) return { ok: false, error: `model "${name}": command must be a non-empty string` };
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) return { ok: false, error: `model "${name}": args must be an array of strings` };
    if (raw.baseUrl !== undefined) return { ok: false, error: `model "${name}": use either command or baseUrl, not both` };
    if (raw.adapter !== undefined && raw.adapter !== "stream" && raw.adapter !== "codex") return { ok: false, error: `model "${name}": adapter must be "stream" or "codex"` };
  } else if ((typeof raw.provider === "string" && raw.provider) || (typeof raw.endpoint === "string" && raw.endpoint) || isObj(raw.local)) {
    if (typeof raw.model !== "string" || !raw.model) return { ok: false, error: `model "${name}": model is required` };
  } else {
    if (typeof raw.baseUrl !== "string" || !/^https?:\/\//.test(raw.baseUrl)) return { ok: false, error: `model "${name}": baseUrl must start with http:// or https:// (or set command)` };
    if (typeof raw.model !== "string" || !raw.model) return { ok: false, error: `model "${name}": model is required` };
  }
  if (raw.adc !== undefined) {
    const a = isObj(raw.adc) ? raw.adc : undefined;
    if (!a || typeof a.file !== "string" || !a.file || typeof a.tokenUri !== "string" || !/^https:\/\//.test(a.tokenUri) || typeof a.scope !== "string" || !a.scope) return { ok: false, error: `model "${name}": adc must be { "file": "…", "tokenUri": "https://…", "scope": "…" }` };
  }
  if (raw.signIn !== undefined) {
    const sign = isObj(raw.signIn) ? raw.signIn : undefined;
    if (!sign || (sign.provider !== "claude" && sign.provider !== "chatgpt") || (sign.file !== undefined && typeof sign.file !== "string")) return { ok: false, error: `model "${name}": signIn must be { "provider": "claude" or "chatgpt", "file"?: "…" }` };
    if (raw.command !== undefined) return { ok: false, error: `model "${name}": use either command or signIn, not both` };
    if (raw.api !== "messages" && raw.api !== "responses") return { ok: false, error: `model "${name}": a signIn needs api "messages" or "responses"` };
  }
  if (raw.window !== undefined && !(typeof raw.window === "number" && raw.window > 0)) return { ok: false, error: `model "${name}": window must be a positive number` };
  if (raw.api !== undefined && raw.api !== "chat" && raw.api !== "messages" && raw.api !== "responses" && raw.api !== "ollama") return { ok: false, error: `model "${name}": api must be "chat", "messages", "responses" or "ollama"` };
  if (raw.reasoning !== undefined && raw.reasoning !== "effort" && raw.reasoning !== "none") return { ok: false, error: `model "${name}": reasoning must be "effort" or "none"` };
  const out: ModelEntry = {};
  if (typeof raw.baseUrl === "string") out.baseUrl = raw.baseUrl;
  if (raw.api === "chat" || raw.api === "messages" || raw.api === "responses" || raw.api === "ollama") out.api = raw.api;
  if (typeof raw.model === "string" && raw.model) out.model = raw.model;
  if (typeof raw.provider === "string" && raw.provider) out.provider = raw.provider;
  if (typeof raw.endpoint === "string" && raw.endpoint) out.endpoint = raw.endpoint;
  if (isObj(raw.local) && typeof raw.local.repo === "string" && typeof raw.local.file === "string" && typeof raw.local.window === "number") out.local = { repo: raw.local.repo, file: raw.local.file, window: raw.local.window, ...(typeof raw.local.tools === "boolean" ? { tools: raw.local.tools } : {}) };
  if (isObj(raw.route) && typeof raw.route.base === "string" && (raw.route.api === "chat" || raw.route.api === "responses" || raw.route.api === "messages")) out.route = { api: raw.route.api, base: raw.route.base };
  if (typeof raw.session === "string" && raw.session) out.session = raw.session;
  if (typeof raw.credential === "string" && raw.credential) out.credential = raw.credential;
  if (typeof raw.command === "string") out.command = raw.command;
  if (isObj(raw.adc)) out.adc = { file: raw.adc.file as string, tokenUri: raw.adc.tokenUri as string, scope: raw.adc.scope as string };
  if (isObj(raw.signIn)) out.signIn = { provider: raw.signIn.provider as string, ...(typeof raw.signIn.file === "string" ? { file: raw.signIn.file } : {}) };
  if (raw.adapter === "stream" || raw.adapter === "codex") out.adapter = raw.adapter;
  if (Array.isArray(raw.args)) out.args = raw.args as string[];
  if (isObj(raw.env)) out.env = Object.fromEntries(Object.entries(raw.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
  if (typeof raw.apiKeyEnv === "string") out.apiKeyEnv = raw.apiKeyEnv;
  if (typeof raw.window === "number") out.window = raw.window;
  if (typeof raw.vision === "boolean") out.vision = raw.vision;
  if (typeof raw.pdf === "boolean") out.pdf = raw.pdf;
  if (typeof raw.catalog === "string" && raw.catalog) out.catalog = raw.catalog;
  if (raw.reasoning === "effort" || raw.reasoning === "none") out.reasoning = raw.reasoning;
  if (isObj(raw.headers)) out.headers = Object.fromEntries(Object.entries(raw.headers).filter((e): e is [string, string] => typeof e[1] === "string"));
  if (raw.display !== undefined) {
    if (!isObj(raw.display)) return { ok: false, error: `model "${name}": display must be an object` };
    const d = raw.display;
    out.display = { ...(typeof d.name === "string" ? { name: d.name } : {}), ...(typeof d.brand === "string" ? { brand: d.brand } : {}), ...(typeof d.badge === "string" ? { badge: d.badge } : {}), ...(typeof d.blurb === "string" ? { blurb: d.blurb } : {}), ...(d.locked === true ? { locked: true } : {}) };
  }
  if (raw.efforts !== undefined) {
    if (!(Array.isArray(raw.efforts) && raw.efforts.every((l) => EFFORTS.includes(l as Effort)))) return { ok: false, error: `model "${name}": efforts must be a list of ${EFFORTS.join(", ")}` };
    out.efforts = raw.efforts as Effort[];
  }
  if (raw.models !== undefined) {
    const listed = Array.isArray(raw.models) && raw.models.every((m) => isObj(m) && typeof m.id === "string" && m.id && typeof m.name === "string" && m.name);
    if (!listed) return { ok: false, error: `model "${name}": models must be a list of { "id", "name" }` };
    out.models = (raw.models as Record<string, unknown>[]).map((m) => ({ id: m.id as string, name: m.name as string, ...(typeof m.badge === "string" ? { badge: m.badge } : {}), ...(typeof m.blurb === "string" ? { blurb: m.blurb } : {}) }));
  }
  return { ok: true, value: out };
}

/** Read the configuration file. A missing file is not an error (`null`); a broken one is. */
/** The file's models, with the models of the signed-in account added (as last listed by the server), so that every screen treats them alike. */
function withAccount(file: ConfigFile | null, path: string, env: Env): ConfigFile | null {
  const account = readAccount(joiner(process.platform)(dirnameOf(path, process.platform), "account.json"));
  const listing = account ? readHostedModels(hostedModelsPath(env)) : undefined;
  if (!account) {
    // Not signed in: the free models of navvied.com, as last listed (see ensureGuestModels), unless the person turned them off.
    const free = file?.guestModels === false ? undefined : readHostedModels(guestModelsPath(env));
    if (!free?.models.length) return file;
    // They are offered, never chosen for the person: nothing the person types leaves the computer for navvied.com unless they pick one of these.
    const mine = Object.keys(file?.models ?? {});
    const start = file?.default ?? (mine.length === 1 ? mine[0] : undefined);
    return { ...(file ?? {}), models: { ...guestEntries(DEFAULT_SERVER, free), ...(file?.models ?? {}) }, ...(start ? { default: start } : {}) };
  }
  if (!listing?.models.length) return file;
  const own = Object.keys(file?.models ?? {});
  const fallback = file?.default ?? (own.length === 1 ? own[0] : own.length ? undefined : listing.default && listing.models.some((m) => m.id === listing.default) ? `${HOSTED_PREFIX}${listing.default}` : `${HOSTED_PREFIX}${listing.models.find((m) => !m.locked)?.id ?? listing.models[0]!.id}`);
  return { ...(file ?? {}), models: { ...hostedEntries(account, listing), ...(file?.models ?? {}) }, ...(fallback ? { default: fallback } : {}) };
}

/** Whether this program runs inside Navvied Cloud (a sandboxed session, or one that reaches the web through the service's proxy): there the computer's own account and its pages do not apply. */
export function runsInCloud(options: { sandboxed?: boolean; config?: string }, env: Env): boolean {
  const f = loadConfigFile(configPath(env, options.config));
  return !!options.sandboxed || (f.ok && !!f.value?.webProxy);
}

export function loadConfig(path: string, env?: Env): Result<ConfigFile | null> {
  const loaded = loadConfigFile(path);
  return env && loaded.ok ? { ok: true, value: withAccount(loaded.value, path, env) } : loaded;
}

function loadConfigFile(path: string): Result<ConfigFile | null> {
  if (!existsSync(path)) return { ok: true, value: null };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { ok: false, error: `${path}: ${e instanceof Error ? e.message : "invalid JSON"}` }; }
  if (!isObj(raw) || !isObj(raw.models)) return { ok: false, error: `${path}: expected { "models": { … } }` };
  const models: Record<string, ModelEntry> = {};
  for (const [name, value] of Object.entries(raw.models)) {
    const r = entry(name, value);
    if (!r.ok) return { ok: false, error: `${path}: ${r.error}` };
    models[name] = r.value;
  }
  const config: ConfigFile = { models };
  if (raw.hooks !== undefined) {
    if (!isObj(raw.hooks)) return { ok: false, error: `${path}: "hooks" must be an object of events` };
    const hooks: HookConfig = {};
    for (const [event, list] of Object.entries(raw.hooks)) {
      if (!HOOK_EVENTS.includes(event)) return { ok: false, error: `${path}: hooks: "${event}" is not an event (${HOOK_EVENTS.join(", ")})` };
      if (!Array.isArray(list) || !list.every((h) => isObj(h) && typeof h.command === "string" && h.command)) return { ok: false, error: `${path}: hooks: ${event} must be a list of { "command": "…" }` };
      hooks[event as HookEvent] = list.map((h) => ({ command: h.command as string, ...(typeof h.matcher === "string" ? { matcher: h.matcher } : {}), ...(typeof h.timeout === "number" && h.timeout > 0 ? { timeout: h.timeout } : {}) }));
    }
    if (Object.keys(hooks).length) config.hooks = hooks;
  }
  if (raw.fallback !== undefined) {
    if (!Array.isArray(raw.fallback) || !raw.fallback.every((n) => typeof n === "string" && n in models)) return { ok: false, error: `${path}: "fallback" must be a list of names of models in "models"` };
    if (raw.fallback.length) config.fallback = raw.fallback as string[];
  }
  if (raw.skills !== undefined) {
    const k = raw.skills as { approval?: unknown; trust?: unknown } | null;
    if (!k || typeof k !== "object" || Array.isArray(k) || (k.approval !== undefined && k.approval !== "ask" && k.approval !== "auto") || (k.trust !== undefined && k.trust !== "confirm")) return { ok: false, error: `${path}: "skills" may have "approval" ("ask" or "auto") and "trust" ("confirm")` };
    config.skills = { ...(k.approval ? { approval: k.approval as "ask" | "auto" } : {}), ...(k.trust ? { trust: "confirm" as const } : {}) };
  }
  if (raw.steps !== undefined) {
    if (raw.steps !== "list" && raw.steps !== "fold" && raw.steps !== "all") return { ok: false, error: `${path}: "steps" must be "list", "fold" or "all"` };
    config.steps = raw.steps;
  }
  if (raw.terminal !== undefined) {
    const t = raw.terminal as { docker?: { image?: unknown }; ssh?: { host?: unknown; user?: unknown; dir?: unknown } } | null;
    if (!t || typeof t !== "object" || Array.isArray(t)) return { ok: false, error: `${path}: "terminal" must be an object` };
    const text = (v: unknown): boolean => typeof v === "string" && v.length > 0 && v.length < 300 && !/[\s;&|`$<>]/.test(v);
    const terminal: TerminalConfig = {};
    if (t.docker !== undefined) {
      if (typeof t.docker !== "object" || t.docker === null || (t.docker.image !== undefined && !text(t.docker.image))) return { ok: false, error: `${path}: "terminal.docker.image" must be an image name such as "debian:stable-slim"` };
      terminal.docker = { ...(t.docker.image ? { image: t.docker.image as string } : {}) };
    }
    if (t.ssh !== undefined) {
      if (typeof t.ssh !== "object" || t.ssh === null || !text(t.ssh.host) || (t.ssh.user !== undefined && !text(t.ssh.user)) || (t.ssh.dir !== undefined && typeof t.ssh.dir !== "string")) return { ok: false, error: `${path}: "terminal.ssh" needs a "host" (and may have "user" and "dir")` };
      terminal.ssh = { host: t.ssh.host as string, ...(t.ssh.user ? { user: t.ssh.user as string } : {}), ...(t.ssh.dir ? { dir: t.ssh.dir as string } : {}) };
    }
    const env = (t as { env?: unknown }).env;
    if (env !== undefined) {
      if (!Array.isArray(env) || !env.every((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return { ok: false, error: `${path}: "terminal.env" must be a list of variable names such as ["GITHUB_TOKEN"]` };
      if (env.length) terminal.env = env as string[];
    }
    config.terminal = terminal;
  }
  if (raw.folders !== undefined) {
    if (!Array.isArray(raw.folders) || raw.folders.some((f) => typeof f !== "string")) return { ok: false, error: `${path}: "folders" must be a list of folder paths` };
    config.folders = raw.folders as string[];
  }
  if (raw.webProxy !== undefined) {
    const w = raw.webProxy as Record<string, unknown> | null;
    if (typeof w !== "object" || w === null || typeof w.url !== "string" || typeof w.token !== "string" || !/^https?:\/\//.test(w.url) || !w.token) return { ok: false, error: `${path}: "webProxy" needs a web address in "url" and a "token"` };
    config.webProxy = { url: w.url.replace(/\/+$/, ""), token: w.token };
  }
  if (raw.providers !== undefined) {
    if (!isObj(raw.providers)) return { ok: false, error: `${path}: "providers" must be an object` };
    const providers: Record<string, SavedProvider> = {};
    for (const [id, v] of Object.entries(raw.providers)) {
      if (!isObj(v)) return { ok: false, error: `${path}: providers: "${id}" must be an object` };
      const fields = isObj(v.fields) ? Object.fromEntries(Object.entries(v.fields).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
      providers[id] = { ...(typeof v.key === "string" && v.key ? { key: v.key } : {}), ...(typeof v.region === "string" && v.region ? { region: v.region } : {}), ...(typeof v.base === "string" && isBaseAddress(v.base) ? { base: v.base } : {}), ...(fields && Object.keys(fields).length ? { fields } : {}) };
    }
    if (Object.keys(providers).length) config.providers = providers;
  }
  if (raw.endpoints !== undefined) {
    if (!isObj(raw.endpoints)) return { ok: false, error: `${path}: "endpoints" must be an object` };
    const endpoints: Record<string, EndpointRecord> = {};
    for (const [id, v] of Object.entries(raw.endpoints)) {
      if (!isObj(v) || typeof v.name !== "string" || typeof v.baseUrl !== "string" || !/^https?:\/\//.test(v.baseUrl) || !(v.api === "chat" || v.api === "responses" || v.api === "messages" || v.api === "ollama") || !Array.isArray(v.models)) return { ok: false, error: `${path}: endpoints: "${id}" needs a name, a baseUrl, an api and a list of models` };
      const models = v.models.filter((m): m is Record<string, unknown> => isObj(m) && typeof m.id === "string" && !!m.id).map((m) => ({ id: m.id as string, ...(typeof m.window === "number" && m.window > 0 ? { window: m.window } : {}), ...(typeof m.vision === "boolean" ? { vision: m.vision } : {}), ...(typeof m.pdf === "boolean" ? { pdf: m.pdf } : {}) }));
      endpoints[id] = { name: v.name, baseUrl: v.baseUrl, api: v.api, ...(typeof v.key === "string" && v.key ? { key: v.key } : {}), models };
    }
    if (Object.keys(endpoints).length) config.endpoints = endpoints;
  }
  if (raw.applyPatch !== undefined) {
    if (raw.applyPatch !== "auto" && raw.applyPatch !== "on" && raw.applyPatch !== "off") return { ok: false, error: `${path}: "applyPatch" must be "auto", "on" or "off"` };
    config.applyPatch = raw.applyPatch;
  }
  if (raw.guestModels !== undefined) {
    if (typeof raw.guestModels !== "boolean") return { ok: false, error: `${path}: "guestModels" must be true or false` };
    config.guestModels = raw.guestModels;
  }
  if (raw.syncConversations !== undefined) {
    if (typeof raw.syncConversations !== "boolean") return { ok: false, error: `${path}: "syncConversations" must be true or false` };
    config.syncConversations = raw.syncConversations;
  }
  if (raw.permissions !== undefined) {
    if (!isObj(raw.permissions)) return { ok: false, error: `${path}: "permissions" must be an object with allow, ask and deny lists` };
    for (const key of Object.keys(raw.permissions)) if (key !== "allow" && key !== "ask" && key !== "deny") return { ok: false, error: `${path}: permissions: "${key}" is not a list (allow, ask or deny)` };
    for (const key of ["allow", "ask", "deny"] as const) {
      const list = raw.permissions[key];
      if (list !== undefined && (!Array.isArray(list) || !list.every((r) => typeof r === "string" && /^[A-Za-z][A-Za-z0-9_]*(\(.*\))?$/s.test(r.trim())))) return { ok: false, error: `${path}: permissions.${key} must be a list of rules such as "Bash(npm run *)", "Edit(src/**)" or "WebFetch(domain:example.com)"` };
    }
    const rules = parseRules(raw.permissions);
    if (hasRules(rules)) config.permissions = rules;
  }
  if (raw.mcp !== undefined) {
    if (!isObj(raw.mcp)) return { ok: false, error: `${path}: "mcp" must be an object of programs` };
    const mcp: Record<string, McpEntry> = {};
    for (const [name, value] of Object.entries(raw.mcp)) {
      if (!isObj(value)) return { ok: false, error: `${path}: connected program "${name}" must be an object` };
      const hasUrl = typeof value.url === "string" && value.url, hasCommand = typeof value.command === "string" && value.command;
      if (!hasUrl && !hasCommand) return { ok: false, error: `${path}: connected program "${name}" needs a command (a program on this computer) or a url (a server on the web)` };
      if (hasUrl && hasCommand) return { ok: false, error: `${path}: connected program "${name}": use either command or url, not both` };
      if (hasUrl) {
        if (!/^https?:\/\//.test(value.url as string)) return { ok: false, error: `${path}: connected program "${name}": url must start with http:// or https://` };
        mcp[name] = { url: value.url as string, ...(isObj(value.headers) ? { headers: Object.fromEntries(Object.entries(value.headers).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}) };
        continue;
      }
      if (value.args !== undefined && !(Array.isArray(value.args) && value.args.every((a) => typeof a === "string"))) return { ok: false, error: `${path}: connected program "${name}": args must be an array of strings` };
      mcp[name] = { command: value.command as string, ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}), ...(isObj(value.env) ? { env: Object.fromEntries(Object.entries(value.env).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}), ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}) };
    }
    if (Object.keys(mcp).length) config.mcp = mcp;
  }
  if (typeof raw.default === "string") config.default = raw.default;
  if (typeof raw.theme === "string") config.theme = raw.theme;
  if (typeof raw.accent === "string") config.accent = raw.accent;
  if (typeof raw.autoUpdate === "boolean") config.autoUpdate = raw.autoUpdate;
  return { ok: true, value: config };
}

const DEFAULT_WINDOW = 128_000;
const DEFAULT_EFFORTS: Effort[] = ["low", "medium", "high"];
const toResolved = (name: string, e: ModelEntry, env: Env): ResolvedModel => {
  if (e.command) {
    return { name, window: e.window ?? DEFAULT_WINDOW, ...(e.efforts?.length ? { efforts: e.efforts } : {}), cli: { command: e.command, args: e.args ?? [], ...(e.model ? { model: e.model } : {}), env: e.env ?? {}, ...(e.adapter ? { adapter: e.adapter } : {}), ...(e.models?.length ? { models: e.models } : {}) } };
  }
  const apiKey = (e.apiKeyEnv ? env[e.apiKeyEnv] : undefined) ?? e.apiKey;
  const provider: ChatCompletionsConfig = { baseUrl: e.baseUrl ?? "", model: e.model ?? "", ...(apiKey ? { apiKey } : {}), ...(e.reasoning ? { reasoning: e.reasoning } : {}), ...(e.headers ? { headers: e.headers } : {}) };
  const efforts = e.efforts ?? (e.reasoning === "effort" ? DEFAULT_EFFORTS : undefined);
  return { name, provider, window: e.window ?? DEFAULT_WINDOW, ...(e.api ? { api: e.api } : {}), ...(e.signIn ? { signIn: e.signIn } : {}), ...(e.adc ? { adc: e.adc } : {}), ...(efforts?.length ? { efforts } : {}), ...(e.vision !== undefined ? { vision: e.vision } : {}), ...(e.pdf ? { pdf: true } : {}) };
};

/** Pick the model to use: `--model`, else the file's default, else its only entry, else the NAVVIED_* environment. */
export function resolveModel(choice: string | undefined, file: ConfigFile | null, env: Env, path: string): Result<ResolvedModel> {
  const names = Object.keys(file?.models ?? {});
  // A model of this computer's own server counts as a choice only while the server runs: one that a crash left behind must not turn "the only model" into "several".
  const choices = names.filter((n) => !file!.models[n]!.local || !("error" in expandLocalModel(localDir(env), file!.models[n]!)));
  const wanted = choice ?? file?.default ?? (choices.length === 1 ? choices[0] : undefined);
  if (wanted) {
    const e = file?.models[wanted];
    if (!e) return { ok: false, error: `unknown model "${wanted}"${names.length ? ` (configured: ${names.join(", ")})` : ` — no models are configured in ${path}`}` };
    if (e.local) {
      const made = expandLocalModel(localDir(env), e);
      return "error" in made ? { ok: false, error: made.error } : { ok: true, value: toResolved(wanted, made.entry, env) };
    }
    if (e.endpoint) {
      const made = expandEndpointModel(file?.endpoints, e);
      return "error" in made ? { ok: false, error: made.error } : { ok: true, value: toResolved(wanted, made.entry, env) };
    }
    if (e.provider) {
      const made = expandModel(PROVIDERS, file?.providers, e);
      return "error" in made ? { ok: false, error: made.error } : { ok: true, value: toResolved(wanted, made.entry, env) };
    }
    return { ok: true, value: toResolved(wanted, e, env) };
  }
  if (env.NAVVIED_BASE_URL && env.NAVVIED_MODEL) {
    const window = Number(env.NAVVIED_WINDOW);
    return { ok: true, value: toResolved(env.NAVVIED_MODEL, { baseUrl: env.NAVVIED_BASE_URL, model: env.NAVVIED_MODEL, ...(env.NAVVIED_API_KEY ? { apiKey: env.NAVVIED_API_KEY } : {}), ...(window > 0 ? { window } : {}), ...(env.NAVVIED_API === "chat" || env.NAVVIED_API === "messages" || env.NAVVIED_API === "responses" || env.NAVVIED_API === "ollama" ? { api: env.NAVVIED_API } : {}) }, env) };
  }
  if (choices.length > 1) return { ok: false, error: `several models are configured (${choices.join(", ")}); choose one with --model or set "default" in ${path}` };
  return { ok: false, error: "no model is connected yet. Run navvied init to connect one." };
}

/** Whether a model can be resolved right now (a configuration file entry or the NAVVIED_* environment). */
export function isConfigured(options: { model?: string; config?: string }, io: { env: Env }): boolean {
  const path = configPath(io.env, options.config);
  const file = loadConfig(path, io.env);
  return file.ok && resolveModel(options.model, file.value, io.env, path).ok;
}

/** Change top-level settings (theme, accent) in the configuration file, keeping everything else as it is. */
export function updateConfig(path: string, patch: { theme?: string; accent?: string | undefined }): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  if (patch.theme !== undefined) config.theme = patch.theme;
  if ("accent" in patch) { if (patch.accent === undefined) delete config.accent; else config.accent = patch.accent; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

/** Remembers a command pattern ("git status *") as always allowed from now on, in every session: added to the configuration file's own rules, not just this run. */
export function rememberBashPattern(path: string, pattern: string): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  const rule = `Bash(${pattern})`;
  const allow = config.permissions?.allow ?? [];
  if (!allow.includes(rule)) config.permissions = { allow: [...allow, rule], ask: config.permissions?.ask ?? [], deny: config.permissions?.deny ?? [] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

/** Keeps what is saved for one provider (or takes it away: `undefined`) in the configuration file, which only its owner can read. */
export function saveProvider(path: string, id: string, saved: SavedProvider | undefined): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  const providers = { ...config.providers };
  if (saved && Object.keys(saved).length) providers[id] = saved; else delete providers[id];
  if (Object.keys(providers).length) config.providers = providers; else delete config.providers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

/** Adds (or replaces) one model of the configuration file. */
export function saveModel(path: string, name: string, entry: ModelEntry): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  config.models = { ...config.models, [name]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

/** Takes one model out of the configuration file; what pointed at it is let go. */
export function removeModel(path: string, name: string): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  delete config.models[name];
  if (config.default === name) delete config.default;
  config.fallback = config.fallback?.filter((n) => n !== name);
  if (!config.fallback?.length) delete config.fallback;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

/** Keeps an endpoint, or takes it away (`undefined`) with every model made from it; the models of an endpoint are entries of the configuration that hold only the endpoint's id. */
export function saveEndpoint(path: string, id: string, record: EndpointRecord | undefined): Result<ConfigFile> {
  const existing = loadConfig(path);
  if (!existing.ok) return existing;
  const config: ConfigFile = existing.value ?? { models: {} };
  for (const [name, m] of Object.entries(config.models)) if (m.endpoint === id) delete config.models[name];
  const endpoints = { ...config.endpoints };
  if (record) {
    endpoints[id] = record;
    const names = modelNames(id, record.models);
    for (const m of record.models) config.models[names.get(m.id)!] = endpointModel(id, record, m);
  } else delete endpoints[id];
  // What pointed at a model that is gone is let go; what still points at one that is there stays (saving an endpoint again keeps the choice of the person).
  if (config.default && !(config.default in config.models)) delete config.default;
  config.fallback = config.fallback?.filter((n) => n in config.models);
  if (!config.fallback?.length) delete config.fallback;
  if (Object.keys(endpoints).length) config.endpoints = endpoints; else delete config.endpoints;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { ok: true, value: config };
}

