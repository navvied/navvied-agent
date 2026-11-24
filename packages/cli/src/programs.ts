import { loginStoreFor } from "./logins.ts";
import type { System } from "./system.ts";

/** What the setup screens and the accounts page both ask of the official programs a person signs in to with a plan. Nothing here signs in, and nothing reads a saved login. */
type Run = Pick<System, "run">;

export const programVersion = async (sys: Run, path: string): Promise<string | undefined> => {
  const r = await sys.run([path, "--version"], { timeoutMs: 4000 }).catch(() => undefined);
  return r ? /\d+\.\d+\.\d+/.exec(r.output)?.[0] : undefined;
};

export interface ClaudeStatus { loggedIn: boolean; method?: string; account?: string; plan?: string }

/** What `claude auth status --json` says: the program reports its own sign-in. */
export async function claudeStatus(sys: Run, path: string): Promise<ClaudeStatus> {
  const r = await sys.run([path, "auth", "status", "--json"], { timeoutMs: 8000 }).catch(() => undefined);
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

/** What `codex login status` says. */
export async function codexStatus(sys: Run, path: string): Promise<CodexStatus> {
  const r = await sys.run([path, "login", "status"], { timeoutMs: 8000 }).catch(() => undefined);
  const text = stripColour(r?.output ?? "");
  if (!r || r.code !== 0 || /not logged in/i.test(text)) return { loggedIn: false };
  return { loggedIn: true, method: /chatgpt/i.test(text) ? "your ChatGPT account" : /api key/i.test(text) ? "an API key" : "your account" };
}

/** The official installers, as the program's own makers publish them. */
export const CLAUDE_INSTALL = { unix: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex" } as const;

export interface InstallPlan { id: string; command: string; /** What to run: shown to the person first, as `shown`. */ argv: string[]; shown: string; /** What it changes, in a sentence. */ note: string }

/** What to run to install a program, or why it cannot be done from here (the way to install it by hand is the program's own page). */
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

/** What the program says of its own sign-in, whichever program it is: the account and plan only when it says them. */
export async function programStatus(id: string, sys: Run, path: string): Promise<{ loggedIn: boolean; account?: string; plan?: string }> {
  return id === "codex" ? codexStatus(sys, path) : claudeStatus(sys, path);
}

const BROWSER_URL = /https:\/\/\S+/;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

export interface SignInHow { /** Claude: sign in with an Anthropic Console account instead of a subscription. */ console?: boolean; /** Codex: a code to enter on another device instead of the browser of this computer. */ device?: boolean }

/**
 * The program's own sign-in, started and watched: it opens the browser on this computer, prints the address (and for a device sign-in, the code), and is done when the
 * program reports a login. The setup screens and the accounts page both run it through this, so there is one way to start it and one way to read what it says.
 */
export class ProgramSignIn {
  url: string | undefined;
  code: string | undefined;
  finished = false;
  readonly done: Promise<unknown>;
  readonly #controller = new AbortController();
  #type: ((line: string) => void) | undefined;

  constructor(readonly id: string, private readonly sys: System, private readonly path: string, how: SignInHow = {}) {
    const codex = id === "codex";
    const argv = codex ? [path, "login", ...(how.device ? ["--device-auth"] : [])] : [path, "auth", "login", how.console ? "--console" : "--claudeai"];
    this.done = sys.run(argv, {
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

  /** Types a line into the program (the code a sign-in page shows). Only the Claude program takes one. */
  type(line: string): void { this.#type?.(line); }
  signedIn = async (): Promise<boolean> => (await programStatus(this.id, this.sys, this.path)).loggedIn;
  stop(): void { this.#controller.abort(); }
}

/** Whether the program has left a saved login on this computer that navvied can read (the setup writes an entry that uses it only then). Nothing of it is read into a message. */
export const programLoginReadable = (id: string, env: Record<string, string | undefined>): boolean => loginStoreFor(id === "codex" ? "chatgpt" : "claude", undefined, env).read() !== undefined;
