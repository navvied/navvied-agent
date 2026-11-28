import type { ModelEntry } from "./config.ts";
import { PROGRAM_SIGN_IN, programMaker, type ProgramMaker } from "./presets.ts";
import { loginStoreFor } from "./logins.ts";
import type { System } from "./system.ts";

type Run = Pick<System, "run">;

export type EntryEnv = Readonly<Record<string, string>>;

export const makerOfAccount = (id: string): ProgramMaker => (id === "codex" ? "codex" : "claude");

export interface ProgramEntries { models: Readonly<Record<string, ModelEntry>>; inUse?: string | undefined }

export function entryEnvOf({ models, inUse }: ProgramEntries, id: string): EntryEnv {
  const ofThisProgram = (m: ModelEntry | undefined): boolean => m?.command !== undefined && programMaker(m.command) === makerOfAccount(id);
  const one = inUse !== undefined && ofThisProgram(models[inUse]) ? models[inUse] : Object.values(models).find(ofThisProgram);
  return one?.env ?? {};
}

export const programVersion = async (sys: Run, path: string): Promise<string | undefined> => {
  const r = await sys.run([path, "--version"], { timeoutMs: 4000 }).catch(() => undefined);
  return r ? /\d+\.\d+\.\d+/.exec(r.output)?.[0] : undefined;
};

export interface ClaudeStatus { loggedIn: boolean; method?: string; account?: string; plan?: string }

export async function claudeStatus(sys: Run, path: string, env: EntryEnv = {}): Promise<ClaudeStatus> {
  const r = await sys.run([path, "auth", "status", "--json"], { timeoutMs: 8000, keep: PROGRAM_SIGN_IN.claude, env }).catch(() => undefined);
  const json = r?.output.slice(r.output.indexOf("{"));
  try {
    const data = JSON.parse(json ?? "") as Record<string, unknown>;
    const text = (keys: string[]): string | undefined => keys.map((k) => data[k]).find((v): v is string => typeof v === "string" && v !== "");
    const account = text(["email", "accountEmail", "account"]);
    const plan = text(["subscriptionType", "plan", "subscription"]);
    return { loggedIn: data.loggedIn === true, ...(typeof data.authMethod === "string" ? { method: data.authMethod } : {}), ...(account ? { account } : {}), ...(plan ? { plan } : {}) };
  } catch { return { loggedIn: false }; }
}

const stripColour = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

export interface CodexStatus { loggedIn: boolean; method?: string }

export async function codexStatus(sys: Run, path: string, env: EntryEnv = {}): Promise<CodexStatus> {
  const r = await sys.run([path, "login", "status"], { timeoutMs: 8000, keep: PROGRAM_SIGN_IN.codex, env }).catch(() => undefined);
  const text = stripColour(r?.output ?? "");
  if (!r || r.code !== 0 || /not logged in/i.test(text)) return { loggedIn: false };
  return { loggedIn: true, method: /chatgpt/i.test(text) ? "your ChatGPT account" : /api key/i.test(text) ? "an API key" : "your account" };
}

export const CLAUDE_INSTALL = { unix: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex" } as const;

export interface InstallPlan { id: string; command: string; argv: string[]; shown: string; note: string }

export function installPlan(id: string, platform: NodeJS.Platform, env: Record<string, string | undefined>, which: (command: string) => string | undefined): InstallPlan | { error: string } {
  const windows = platform === "win32";
  if (id !== "claude-code" && id !== "codex") return { error: "That program is not known." };
  if (id === "claude-code") {
    const shown = windows ? CLAUDE_INSTALL.windows : CLAUDE_INSTALL.unix;
    return { id, command: "claude", shown, argv: windows ? ["powershell", "-NoProfile", "-Command", shown] : ["sh", "-c", shown], note: "It downloads and runs Claude's official installer from claude.ai. Nothing else on your computer is changed." };
  }
  const npm = which("npm");
  if (!npm) return { error: "npm was not found on this computer: install Node.js from nodejs.org first (or use Homebrew: brew install codex)." };
  const home = env.HOME ?? env.USERPROFILE ?? "~";
  const argv = windows ? [npm, "install", "-g", "@openai/codex"] : [npm, "install", "-g", "--prefix", `${home}/.local`, "@openai/codex"];
  return {
    id, command: "codex", argv,
    shown: windows ? "npm install -g @openai/codex" : "npm install -g --prefix ~/.local @openai/codex",
    note: windows ? "It downloads Codex from npm into npm's own folder. Nothing else on your computer is changed." : "It downloads Codex from npm into your own folder (~/.local), so it needs no administrator password. Nothing else on your computer is changed.",
  };
}

export async function programStatus(id: string, sys: Run, path: string, env: EntryEnv = {}): Promise<{ loggedIn: boolean; account?: string; plan?: string }> {
  return id === "codex" ? codexStatus(sys, path, env) : claudeStatus(sys, path, env);
}

const BROWSER_URL = /https:\/\/\S+/;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

export interface SignInHow { console?: boolean; device?: boolean }

export class ProgramSignIn {
  url: string | undefined;
  code: string | undefined;
  finished = false;
  readonly done: Promise<unknown>;
  readonly #controller = new AbortController();
  #type: ((line: string) => void) | undefined;

  constructor(readonly id: string, private readonly sys: System, private readonly path: string, how: SignInHow = {}, private readonly env: EntryEnv = {}) {
    const codex = id === "codex";
    const argv = codex ? [path, "login", ...(how.device ? ["--device-auth"] : [])] : [path, "auth", "login", how.console ? "--console" : "--claudeai"];
    this.done = sys.run(argv, {
      keep: PROGRAM_SIGN_IN[codex ? "codex" : "claude"],
      env,
      signal: this.#controller.signal,
      timeoutMs: how.device ? 20 * 60_000 : 600_000,
      onLine: (line) => {
        const plain = stripColour(line);
        this.url ??= BROWSER_URL.exec(plain)?.[0];
        if (how.device && this.url && !this.code && !plain.includes(this.url)) this.code = DEVICE_CODE.exec(plain)?.[0];
      },
      ...(codex ? {} : { input: (write: (line: string) => void) => { this.#type = write; } }),
    }).then((r) => { this.finished = true; return r; }, () => { this.finished = true; });
  }

  type(line: string): void { this.#type?.(line); }
  signedIn = async (): Promise<boolean> => (await programStatus(this.id, this.sys, this.path, this.env)).loggedIn;
  stop(): void { this.#controller.abort(); }
}

export const programLoginReadable = (id: string, env: Record<string, string | undefined>): boolean => loginStoreFor(id === "codex" ? "chatgpt" : "claude", undefined, env).read() !== undefined;
