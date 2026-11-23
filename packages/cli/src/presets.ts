import type { ProviderEntry } from "./providers.ts";
import { loginStoreFor } from "./logins.ts";
import type { Effort } from "@navvied/protocol";
import type { ModelEntry } from "./config.ts";
import { guestModelsPath } from "./config.ts";
import { DEFAULT_SERVER, GUEST_PREFIX, guestEntries, writeHostedModels } from "./account.ts";
import { fetchGuestModels } from "./account-client.ts";
import type { Choice, IO, Watch, WorkContext } from "./io.ts";
import { paint } from "./render.ts";
import { looksLikeKey, type System } from "./system.ts";

/** The only file that names outside services: it is what lets a newcomer pick theirs from a list. */
export interface LocalServer { name: string; baseUrl: string; models: string[]; /** Ollama, which has its own API that can set the model's memory. */ ollama?: boolean }

export interface Screen {
  io: IO;
  sys: System;
  /** A menu. Resolves to the index, or "back". Cancelling throws. */
  pick(title: string, items: Choice[], initial?: number, watch?: Watch, body?: string[]): Promise<number | "back">;
  /** A hidden paste field. Resolves to the text, or "back". Cancelling throws. */
  secret(prompt: string): Promise<string | "back">;
  /** A short typed answer, for when nothing can be chosen. Cancelling throws; "back" throws a signal that returns to the list. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Like ask, but Left comes back as "back" instead of leaving the whole list. */
  askOrBack(question: string, fallback?: string, body?: string[]): Promise<string | "back">;
  /** Show something that went wrong or needs doing, on the next screen. */
  say(text: string): void;
  /** A screen that waits for the task. Resolves to its result, or "back". Cancelling throws. */
  work<T>(title: string, parts: { body?: string[]; status?: string }, task: (context: WorkContext) => Promise<T>): Promise<T | "back">;
  /** Model servers found on this computer. */
  local: LocalServer[];
}

export interface Preset {
  label: string;
  hint: string;
  /** Build the model entry, or "back" to return to the list. */
  configure(s: Screen): Promise<{ name: string; entry: ModelEntry } | "back">;
}

type Key = { apiKey?: string; apiKeyEnv?: string };
type Result = { name: string; entry: ModelEntry } | "back";

const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
const POLL_MS = 700;
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });

interface Service {
  name: string;
  env: string;
  prefix: string;
  /** Other kinds of key that share the start of this one. */
  not?: string[];
  page: string;
  baseUrl: string;
  api?: "messages";
  /** Every model of the service can see pictures, and (messages API) reads a PDF given as a file. */
  vision?: true;
  pdf?: true;
  window: number;
  headers(key: string): Record<string, string>;
  keep?(id: string): boolean;
}

const ANTHROPIC: Service = {
  name: "Anthropic", env: "ANTHROPIC_API_KEY", prefix: "sk-ant-", page: "https://console.anthropic.com/settings/keys",
  baseUrl: "https://api.anthropic.com/v1", api: "messages", vision: true, pdf: true, window: 200_000,
  headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
};

const OPENAI: Service = {
  name: "OpenAI", env: "OPENAI_API_KEY", prefix: "sk-", not: ["sk-ant-", "sk-or-"], page: "https://platform.openai.com/api-keys",
  baseUrl: "https://api.openai.com/v1", vision: true, window: 128_000, headers: (key) => ({ authorization: `Bearer ${key}` }),
  keep: (id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|whisper|embed|image|moderation|transcribe|search|instruct)/.test(id),
};

const OPENROUTER: Service = {
  name: "OpenRouter", env: "OPENROUTER_API_KEY", prefix: "sk-or-", page: "https://openrouter.ai/keys",
  baseUrl: "https://openrouter.ai/api/v1", window: 128_000, headers: (key) => ({ authorization: `Bearer ${key}` }),
};

const isKey = (svc: Service, text: string | undefined): text is string => looksLikeKey(text, svc.prefix) && !svc.not?.some((p) => text.startsWith(p));

/** Where the key comes from, chosen from a list: the clipboard, an environment variable, or a page that makes one. The list follows the clipboard while it is open. */
async function keyFor(s: Screen, svc: Service): Promise<Key | "back"> {
  let waiting = false;
  let clip = await s.sys.clipboard();
  type Item = { label: string; hint: string; take: () => Promise<Key | "back" | "again"> };
  const build = (): Item[] => {
    const items: Item[] = [];
    if (isKey(svc, clip)) { const key = clip; items.push({ label: "Use the key in my clipboard", hint: `Found a key starting with ${svc.prefix} (${key.length} characters). Stored only on this computer.`, take: async () => ({ apiKey: key }) }); }
    if (s.io.env[svc.env]) items.push({ label: `Use the key from ${svc.env}`, hint: "Already set in this terminal. Nothing is stored in navvied's file.", take: async () => ({ apiKeyEnv: svc.env }) });
    items.push({ label: "Open the page where keys are made", hint: `${new URL(svc.page).host}. Create a key and copy it. This screen notices by itself.`, take: async () => { s.sys.open(svc.page); waiting = true; return "again"; } });
    items.push({ label: "Paste it here", hint: "If you prefer to paste the key yourself.", take: async () => { const v = await s.secret(`Paste your ${svc.name} API key`); return v === "back" || !v ? "again" : { apiKey: v }; } });
    return items;
  };
  const notice = (): string[] => (waiting ? ["Waiting for a key in your clipboard…  Copy the key and this screen moves on by itself."] : []);
  for (;;) {
    let items = build();
    if (waiting) s.say(notice()[0]!);
    const watch: Watch = {
      everyMs: POLL_MS,
      async next() {
        const text = await s.sys.clipboard();
        if (!isKey(svc, text) || text === clip) return undefined;
        clip = text;
        items = build();
        return waiting ? { auto: 0 } : { items: items.map(({ label, hint }) => ({ label, hint })), at: 0 };
      },
    };
    const at = await s.pick("Your API key", items.map(({ label, hint }) => ({ label, hint })), 0, watch);
    if (at === "back") return "back";
    const taken = await items[at]!.take();
    if (taken !== "again") return taken;
  }
}

type Listing = { ids: string[] } | { unauthorised: number } | { failed: true };

async function listModels(s: Screen, baseUrl: string, headers: Record<string, string>, keep: (id: string) => boolean = () => true): Promise<Listing> {
  try {
    const res = await s.io.fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { unauthorised: res.status };
    if (!res.ok) return { failed: true };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && keep(id)).sort();
    return ids.length ? { ids } : { failed: true };
  } catch { return { failed: true }; }
}

/** The model to use: chosen from the service's own list; if that cannot be read, try again or type the name. */
async function chooseModel(s: Screen, load: () => Promise<Listing>): Promise<string | "back" | { unauthorised: number }> {
  for (;;) {
    const listing = await load();
    if ("unauthorised" in listing) return listing;
    if ("ids" in listing) {
      const at = await s.pick("Which model?", listing.ids.map((id) => ({ label: id })));
      return at === "back" ? "back" : listing.ids[at]!;
    }
    s.say("The server did not send its list of models. It may still be starting.");
    const at = await s.pick("Which model?", [{ label: "Try again", hint: "Asks the server for its list of models once more." }, { label: "Type the model name", hint: "Only if you know it." }]);
    if (at === "back") return "back";
    if (at === 1) {
      const name = await s.ask("Model name");
      if (/^https?:\/\//i.test(name)) { s.say("That is an address, not a model name. A model name looks like gpt-4o or llama3."); continue; }
      return name || "back";
    }
  }
}

const hosted = (svc: Service, label: string, hint: string): Preset => ({
  label,
  hint,
  async configure(s) {
    for (;;) {
      const key = await keyFor(s, svc);
      if (key === "back") return "back";
      const secret = key.apiKey ?? (key.apiKeyEnv ? s.io.env[key.apiKeyEnv] : undefined) ?? "";
      const model = await chooseModel(s, () => listModels(s, svc.baseUrl, svc.headers(secret), svc.keep));
      if (model === "back") return "back";
      if (typeof model === "object") { s.say(`${svc.name} did not accept that key (${model.unauthorised}). Check it and try again.`); continue; }
      return { name: slug(model), entry: { baseUrl: svc.baseUrl, ...(svc.api ? { api: svc.api } : {}), model, window: svc.window, ...(svc.vision ? { vision: true } : {}), ...(svc.pdf ? { pdf: true } : {}), ...key } };
    }
  },
});

const versionOf = async (s: Screen, path: string): Promise<string | undefined> => {
  const r = await s.sys.run([path, "--version"], { timeoutMs: 4000 }).catch(() => undefined);
  return r ? /\d+\.\d+\.\d+/.exec(r.output)?.[0] : undefined;
};

interface ClaudeStatus { loggedIn: boolean; method?: string; account?: string }

async function claudeStatus(s: Screen, path: string): Promise<ClaudeStatus> {
  const r = await s.sys.run([path, "auth", "status", "--json"], { timeoutMs: 8000 }).catch(() => undefined);
  const json = r?.output.slice(r.output.indexOf("{"));
  try {
    const data = JSON.parse(json ?? "") as Record<string, unknown>;
    const account = ["email", "accountEmail", "account"].map((k) => data[k]).find((v): v is string => typeof v === "string");
    return { loggedIn: data.loggedIn === true, ...(typeof data.authMethod === "string" ? { method: data.authMethod } : {}), ...(account ? { account } : {}) };
  } catch { return { loggedIn: false }; }
}

const describeMethod = (method: string | undefined): string => (!method ? "your account" : /console|api/i.test(method) ? "an Anthropic Console account" : /claude|subscription|oauth/i.test(method) ? "your Claude subscription" : method);

const INSTALL = { unix: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex" };

async function installClaude(s: Screen): Promise<"installed" | "back"> {
  const windows = process.platform === "win32";
  const command = windows ? INSTALL.windows : INSTALL.unix;
  const at = await s.pick("Claude Code is not installed on this computer", [
    { label: "Install it for me", hint: "navvied runs Claude's own installer. You will see the command first." },
    { label: "I will install it myself", hint: "Shows the command to run in a terminal." },
  ]);
  if (at === "back") return "back";
  if (at === 1) {
    s.say(`Run this in a terminal, then come back here:\n${INSTALL.unix}   (macOS and Linux)\n${INSTALL.windows}   (Windows)`);
    return "back";
  }
  s.say(`${command}\nIt downloads and runs Claude's official installer from claude.ai. Nothing else on your computer is changed.`);
  if ((await s.pick("Run this command?", [{ label: "Yes, install Claude Code" }, { label: "No, go back" }])) !== 0) return "back";
  const done = await s.work("Installing Claude Code", { body: [command], status: "Installing…" }, ({ log, signal }) =>
    s.sys.run(windows ? ["powershell", "-NoProfile", "-Command", command] : ["sh", "-c", command], { signal, onLine: log, timeoutMs: 600_000 }));
  if (done === "back") return "back";
  if (done.code !== 0 || !s.sys.which("claude")) {
    s.say("The installer did not finish, or claude was not found afterwards. Open a new terminal and try again, or install it yourself.");
    return "back";
  }
  return "installed";
}

/** The value a menu's watcher gives back when the sign-in has finished by itself. */
const FINISHED = 99;

async function signInClaude(s: Screen, path: string, consoleLogin: boolean): Promise<boolean | "back"> {
  const controller = new AbortController();
  let url: string | undefined;
  let type: ((line: string) => void) | undefined;
  let finished = false;
  const login = s.sys.run([path, "auth", "login", consoleLogin ? "--console" : "--claudeai"], {
    signal: controller.signal,
    timeoutMs: 600_000,
    onLine: (line) => { url ??= /https:\/\/\S+/.exec(line)?.[0]; },
    input: (write) => { type = write; },
  });
  void login.then(() => { finished = true; });
  const signedIn = async (): Promise<boolean> => (await claudeStatus(s, path)).loggedIn;

  const submitCode = async (): Promise<boolean | "back"> => {
    for (;;) {
      const code = await s.askOrBack("Paste the code from the browser", "", ["It looks like a short line of letters and numbers. Copy it on the page, then paste it here."]);
      if (code === "back") return "back";
      type?.(code);
      const until = Date.now() + (Number(s.io.env.NAVVIED_CODE_WAIT_MS) || 10_000);
      while (Date.now() < until && !finished) {
        await sleep(Math.min(500, Math.max(10, until - Date.now())), controller.signal);
        if (await signedIn()) return true;
      }
      if (await signedIn()) return true;
      if (finished) return false;
      s.say("Claude Code did not accept that code. It may have expired. Copy the code again, or go back and open the sign-in page again.");
    }
  };

  try {
    await Promise.race([login, sleep(80, controller.signal)]);
    for (;;) {
      if (await signedIn()) return true;
      if (finished) return false;
      s.say("Waiting for you to sign in…  This screen moves on by itself when you are done.");
      const at = await s.pick("Finish signing in in your browser", [
        { label: "I have a code from the browser", hint: "Some sign-in pages show a code. Paste it here and navvied gives it to Claude Code." },
        { label: "Open the sign-in page again", hint: "Opens the same page in your browser." },
        { label: "Show the address", hint: "To open it yourself, on this computer or another one." },
      ], 0, { everyMs: 1500, next: async () => ((await signedIn()) || finished ? { auto: FINISHED } : undefined) },
      ["Your browser opened a Claude sign-in page.", "Sign in and press Allow.", "If the page shows a code instead, choose the first option below."]);
      if (at === "back") return "back";
      if (at === 0) { const done = await submitCode(); if (done !== "back") return done; }
      else if (at === 1) { if (url) s.sys.open(url); else s.say("The sign-in page address is not known yet. Try again in a moment."); }
      else if (at === 2) s.say(url ?? "The sign-in page address is not known yet. Try again in a moment.");
    }
  } finally { controller.abort(); }
}

const CLAUDE_MODELS = [
  { id: "default", name: "Let Claude Code choose", blurb: "Its own default for your plan." },
  { id: "opus", name: "Opus", blurb: "The most capable. Uses your plan faster." },
  { id: "sonnet", name: "Sonnet", blurb: "Fast and capable. A good everyday choice." },
  { id: "haiku", name: "Haiku", blurb: "The fastest and lightest." },
];

/** After signing in: which of the program's models to use. They can be switched later without starting over. */
/** The names the model's own service knows them by, for when navvied talks to it directly with the person's sign-in. */
const CLAUDE_NATIVE: Record<string, string> = { default: "claude-sonnet-5-5", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** Whether the sign-in the program made can be read by navvied itself (a Mac keeps it in the keychain, which asks the person once). */
const loginReadable = (s: Screen, provider: "claude" | "chatgpt"): boolean => loginStoreFor(provider, undefined, s.io.env).read() !== undefined;

async function claudeModel(s: Screen, path: string): Promise<Result | "back"> {
  const at = await s.pick("Which Claude model?", CLAUDE_MODELS.map((m) => ({ label: m.name, hint: m.blurb })), 0);
  if (at === "back") return "back";
  const chosen = CLAUDE_MODELS[at]!;
  // navvied runs the work itself (its own tools, skills, rules and memory) and uses only the model of the sign-in. The program is kept for when the sign-in cannot be read.
  if (loginReadable(s, "claude")) {
    return { name: "claude", entry: { api: "messages", baseUrl: "https://api.anthropic.com/v1", model: CLAUDE_NATIVE[chosen.id] ?? "claude-sonnet-5-5", signIn: { provider: "claude" }, vision: true, pdf: true, window: 200_000, display: { name: chosen.id === "default" ? "Claude" : `Claude ${chosen.name}` } } };
  }
  return { name: "claude", entry: { command: path, window: 200_000, ...(chosen.id === "default" ? {} : { model: chosen.id }), models: CLAUDE_MODELS, efforts: ["low", "medium", "high", "xhigh", "max"] } };
}

/** The programs a person can sign in to and use with their plan, for a page that shows what is installed. */
export const SIGN_IN_PROGRAMS: readonly { id: string; label: string; command: string }[] = [
  { id: "claude", label: "Claude, with your subscription", command: "claude" },
  { id: "codex", label: "Codex, with your ChatGPT plan", command: "codex" },
];

const claudeSubscription: Preset = {
  label: "Claude, with your subscription",
  hint: "Uses the Claude Code program you sign in to. navvied never sees your password.",
  async configure(s) {
    let switching = false;
    for (;;) {
      let path = s.sys.which("claude");
      if (!path) {
        if ((await installClaude(s)) === "back") return "back";
        path = s.sys.which("claude");
        if (!path) return "back";
      }
      const [version, status] = await Promise.all([versionOf(s, path), claudeStatus(s, path)]);
      const program = `Claude Code${version ? ` ${version}` : ""}`;
      if (status.loggedIn && !switching) {
        const at = await s.pick("Claude Code is ready", [
          { label: "Use it", hint: `${program}, signed in with ${describeMethod(status.method)}${status.account ? ` (${status.account})` : ""}.` },
          { label: "Sign in with a different account" },
        ]);
        if (at === "back") return "back";
        if (at === 0) { const picked = await claudeModel(s, path); if (picked === "back") continue; return picked; }
        switching = true;
        continue;
      }
      s.say(`${program} was found on this computer.`);
      const at = await s.pick(`Claude Code is installed, but you are ${switching ? "choosing another account" : "not signed in"}`, [
        { label: "Sign in with my Claude subscription", hint: "Opens your browser. Nothing to paste." },
        { label: "Sign in with an Anthropic Console account", hint: "Pay per use, billed to that account." },
      ]);
      if (at === "back") { if (switching) { switching = false; continue; } return "back"; }
      const ok = await signInClaude(s, path, at === 1);
      if (ok === true) { const picked = await claudeModel(s, path); if (picked !== "back") return picked; continue; }
      if (ok === false) s.say("The sign-in was not finished. It may have been cancelled, or the browser window was closed.");
    }
  },
};

const stripColour = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

interface CodexStatus { loggedIn: boolean; method?: string }

async function codexStatus(s: Screen, path: string): Promise<CodexStatus> {
  const r = await s.sys.run([path, "login", "status"], { timeoutMs: 8000 }).catch(() => undefined);
  const text = stripColour(r?.output ?? "");
  if (!r || r.code !== 0 || /not logged in/i.test(text)) return { loggedIn: false };
  return { loggedIn: true, method: /chatgpt/i.test(text) ? "your ChatGPT account" : /api key/i.test(text) ? "an API key" : "your account" };
}

async function installCodex(s: Screen): Promise<"installed" | "back"> {
  const windows = process.platform === "win32";
  const home = s.io.env.HOME ?? s.io.env.USERPROFILE ?? "~";
  const argv = windows ? ["npm", "install", "-g", "@openai/codex"] : ["npm", "install", "-g", "--prefix", `${home}/.local`, "@openai/codex"];
  const shown = windows ? argv.join(" ") : `npm install -g --prefix ~/.local @openai/codex`;
  const npm = s.sys.which("npm");
  if (!npm) {
    s.say("navvied needs npm to install Codex for you, and npm was not found on this computer.\nYou can install Node.js from nodejs.org, or use Homebrew:  brew install codex");
    const at = await s.pick("Codex is not installed on this computer", [{ label: "I will install it myself", hint: "Shows the commands to run in a terminal." }]);
    if (at !== "back") s.say(`Run this in a terminal, then come back here:\n${shown}   (needs Node.js)\nbrew install codex   (macOS)`);
    return "back";
  }
  const at = await s.pick("Codex is not installed on this computer", [
    { label: "Install it for me", hint: "navvied runs the installer with npm. You will see the command first." },
    { label: "I will install it myself", hint: "Shows the commands to run in a terminal." },
  ]);
  if (at === "back") return "back";
  if (at === 1) { s.say(`Run this in a terminal, then come back here:\n${shown}   (needs Node.js)\nbrew install codex   (macOS)`); return "back"; }
  s.say(`${shown}\n${windows ? "It downloads Codex from npm into npm's own folder." : "It downloads Codex from npm into your own folder (~/.local), so it needs no administrator password."} Nothing else on your computer is changed.`);
  if ((await s.pick("Run this command?", [{ label: "Yes, install Codex" }, { label: "No, go back" }])) !== 0) return "back";
  const done = await s.work("Installing Codex", { body: [shown], status: "Installing…" }, ({ log, signal }) => s.sys.run([npm, ...argv.slice(1)], { signal, onLine: log, timeoutMs: 600_000 }));
  if (done === "back") return "back";
  if (done.code !== 0 || !s.sys.which("codex")) {
    s.say("The installer did not finish, or codex was not found afterwards. Open a new terminal and try again, or install it yourself.");
    return "back";
  }
  return "installed";
}

const BROWSER_URL = /https:\/\/\S+/;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
const DEVICE_WAIT_MS = 10_000;

/** Signs in through the browser on this computer. Resolves true when Codex reports a login, false when it gave up. */
async function codexBrowserSignIn(s: Screen, path: string): Promise<boolean | "back" | "device"> {
  const controller = new AbortController();
  let url: string | undefined;
  let finished = false;
  const login = s.sys.run([path, "login"], { signal: controller.signal, timeoutMs: 600_000, onLine: (line) => { url ??= BROWSER_URL.exec(stripColour(line))?.[0]; } });
  void login.then(() => { finished = true; });
  const signedIn = async (): Promise<boolean> => (await codexStatus(s, path)).loggedIn;
  try {
    await Promise.race([login, sleep(80, controller.signal)]);
    for (;;) {
      if (await signedIn()) return true;
      if (finished) return false;
      s.say("Waiting for you to sign in…  This screen moves on by itself when you are done.");
      const at = await s.pick("Finish signing in in your browser", [
        { label: "Open the sign-in page again", hint: "Opens the same page in your browser." },
        { label: "Show the address", hint: "To open it yourself." },
        { label: "Sign in from another device instead", hint: "Shows a code to enter on your phone or another computer." },
      ], 0, { everyMs: 1500, next: async () => ((await signedIn()) || finished ? { auto: FINISHED } : undefined) },
      ["Your browser opened a ChatGPT sign-in page.", "Sign in and press Continue.", "Come back here. Nothing to paste."]);
      if (at === "back") return "back";
      if (at === 0) { if (url) s.sys.open(url); else s.say("The sign-in page address is not known yet. Try again in a moment."); }
      else if (at === 1) s.say(url ?? "The sign-in page address is not known yet. Try again in a moment.");
      else if (at === 2) return "device";
    }
  } finally { controller.abort(); }
}

/** Signs in with a code entered on another device. */
async function codexDeviceSignIn(s: Screen, path: string): Promise<boolean | "back"> {
  const controller = new AbortController();
  let url: string | undefined;
  let code: string | undefined;
  let finished = false;
  const login = s.sys.run([path, "login", "--device-auth"], {
    signal: controller.signal,
    timeoutMs: 20 * 60_000,
    onLine: (line) => {
      const plain = stripColour(line);
      url ??= BROWSER_URL.exec(plain)?.[0];
      if (url && !code && !plain.includes(url)) code = DEVICE_CODE.exec(plain)?.[0];
    },
  });
  void login.then(() => { finished = true; });
  try {
    const until = Date.now() + DEVICE_WAIT_MS;
    while ((!url || !code) && !finished && Date.now() < until) await sleep(100, controller.signal);
    if (!url || !code) {
      s.say("Codex did not give a code to enter. Check your internet connection and try again.");
      return "back";
    }
    const accent = (t: string): string => paint(s.io.color, "cyan", paint(s.io.color, "bold", t));
    const outcome = await s.work("Sign in from another device", {
      body: ["1  On any device, open this address:", `   ${accent(url)}`, "", "2  Enter this one-time code:", `   ${accent(code)}   (expires in 15 minutes)`, "", "3  Sign in there. This screen moves on by itself when you are done."],
      status: "Waiting for you to sign in…",
    }, async ({ signal }) => {
      while (!signal.aborted) {
        if ((await codexStatus(s, path)).loggedIn) return true;
        if (finished) return false;
        await sleep(1500, signal);
      }
      return false;
    });
    return outcome;
  } finally { controller.abort(); }
}

const codexSubscription: Preset = {
  label: "Codex, with your ChatGPT plan",
  hint: "Uses the Codex program you sign in to. navvied never sees your password.",
  async configure(s) {
    let switching = false;
    for (;;) {
      let path = s.sys.which("codex");
      if (!path) {
        if ((await installCodex(s)) === "back") return "back";
        path = s.sys.which("codex");
        if (!path) return "back";
      }
      const [version, status] = await Promise.all([versionOf(s, path), codexStatus(s, path)]);
      const program = `Codex${version ? ` ${version}` : ""}`;
      const entry: Result = loginReadable(s, "chatgpt")
        ? { name: "codex", entry: { api: "responses", baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5.5", signIn: { provider: "chatgpt" }, vision: true, window: 200_000, display: { name: "ChatGPT" } } }
        : { name: "codex", entry: { command: path, adapter: "codex", window: 200_000, efforts: ["low", "medium", "high", "xhigh"] } };
      if (status.loggedIn && !switching) {
        const at = await s.pick("Codex is ready", [{ label: "Use it", hint: `${program}, signed in with ${status.method}.` }, { label: "Sign in with a different account" }]);
        if (at === "back") return "back";
        if (at === 0) return entry;
        switching = true;
        continue;
      }
      s.say(`${program} was found on this computer.`);
      const at = await s.pick(`Codex is installed, but you are ${switching ? "choosing another account" : "not signed in"}`, [
        { label: "Sign in with my ChatGPT account", hint: "Opens your browser on this computer. Nothing to paste." },
        { label: "Sign in from another device", hint: "For a computer without a browser. Shows a code to enter on another device." },
      ]);
      if (at === "back") { if (switching) { switching = false; continue; } return "back"; }
      let ok: boolean | "back" | "device" = at === 0 ? await codexBrowserSignIn(s, path) : "device";
      if (ok === "device") ok = await codexDeviceSignIn(s, path);
      if (ok === true) return entry;
      if (ok === false) s.say("The sign-in was not finished. It may have been cancelled, or the code may have expired.");
    }
  },
};

const LOCAL_NAMES: Record<number, string> = { 11434: "Ollama", 1234: "LM Studio", 8080: "llama.cpp", 8000: "vLLM" };
export const localName = (baseUrl: string): string => LOCAL_NAMES[Number(new URL(baseUrl).port)] ?? "A model server";

/** The most conversation a small model is given by default: enough to work with, light enough for a laptop. */
const MEMORY_TOKENS = 16_384;
const FALLBACK_MEMORY = 8_192;

/** How many tokens of memory to ask Ollama for with this model: what it supports, up to a sensible amount. */
export async function memoryFor(fetchFn: typeof fetch, root: string, model: string): Promise<number> {
  try {
    const res = await fetchFn(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
    const supported = Object.entries(info).find(([k, v]) => k.endsWith(".context_length") && typeof v === "number")?.[1] as number | undefined;
    return supported ? Math.min(MEMORY_TOKENS, supported) : FALLBACK_MEMORY;
  } catch { return FALLBACK_MEMORY; }
}

/** The headers a service wants for a key: its own kind for the messages API, a bearer token for the rest, none for Ollama. */
export function authHeaders(api: ModelEntry["api"], key: string | undefined): Record<string, string> {
  if (!key) return api === "messages" ? { "anthropic-version": "2023-06-01" } : {};
  return api === "messages" ? ANTHROPIC.headers(key) : { authorization: `Bearer ${key}` };
}

async function serverFlow(s: Screen, offerAddress: boolean, title: string): Promise<Result> {
  if (!s.local.length && !offerAddress) {
    s.say("No model server was found on this computer. Start one (Ollama or LM Studio, for example) and try again.");
    return "back";
  }
  const items: Choice[] = s.local.map((l) => ({ label: `${l.name} on this computer`, hint: `${l.baseUrl}   ${l.models.length} model${l.models.length === 1 ? "" : "s"}` }));
  if (offerAddress) items.push({ label: "A server at another address", hint: "You will type the address." });
  if (s.local.length) s.say(`Found ${s.local.length} server${s.local.length === 1 ? "" : "s"} running on this computer.`);
  for (;;) {
    const at = s.local.length === 1 && !offerAddress ? 0 : await s.pick(title, items);
    if (at === "back") return "back";
    if (at < s.local.length) {
      const server = s.local[at]!;
      const model = await chooseModel(s, async () => (server.models.length ? { ids: server.models } : { failed: true }));
      if (model === "back") { if (s.local.length === 1 && !offerAddress) return "back"; continue; }
      if (typeof model === "object") return "back";
      if (server.ollama) {
        const root = server.baseUrl.replace(/\/v1\/?$/, "");
        return { name: slug(model), entry: { baseUrl: root, api: "ollama", model, window: await memoryFor(s.io.fetch, root, model) } };
      }
      return { name: slug(model), entry: { baseUrl: server.baseUrl, model, reasoning: "none", window: 32_768 } };
    }
    let baseUrl = "";
    for (;;) {
      baseUrl = (await s.ask("API address (ending in /v1)", "https://")).replace(/\/+$/, "");
      if (/^https?:\/\/[^/\s]+/.test(baseUrl)) break;
      s.say("That does not look like an address. It should start with http:// or https://");
    }
    let key: Key = {};
    for (;;) {
      const secret = key.apiKey ?? "";
      const model = await chooseModel(s, () => listModels(s, baseUrl, secret ? { authorization: `Bearer ${secret}` } : {}));
      if (model === "back") break;
      if (typeof model === "object") {
        const pasted = await s.secret("Paste its API key");
        if (pasted === "back") break;
        key = { apiKey: pasted };
        continue;
      }
      return { name: slug(model), entry: { baseUrl, model, window: 128_000, ...key } };
    }
  }
}

const KNOWN_PROGRAMS = ["claude", "codex", "gemini", "opencode", "aider", "goose"];

const otherProgram: Preset = {
  label: "Another agent program",
  hint: "Give the command you would type in a terminal.",
  async configure(s) {
    const found: { command: string; path: string; version?: string }[] = [];
    for (const command of KNOWN_PROGRAMS) {
      const path = s.sys.which(command);
      if (path) { const version = await versionOf(s, path); found.push({ command, path, ...(version ? { version } : {}) }); }
    }
    const items: Choice[] = found.map((f) => ({ label: f.command, hint: `Found at ${f.path}${f.version ? `, version ${f.version}` : ""}` }));
    items.push({ label: "Another program", hint: "You will type its command." });
    if (found.length) s.say(`Found ${found.length} program${found.length === 1 ? "" : "s"} on this computer that can work as an agent.`);
    const at = await s.pick("Which program?", items);
    if (at === "back") return "back";
    if (at < found.length) return { name: slug(found[at]!.command), entry: { command: found[at]!.path, window: 200_000 } };
    const command = await s.ask("Command that starts it");
    if (!command) return "back";
    if (!s.sys.which(command)) s.say(`"${command}" was not found on your PATH. Sign in with it first, and check the name.`);
    return { name: slug(command.split("/").pop() ?? command), entry: { command, window: 200_000 } };
  },
};

/** The free models of navvied.com: no account, no key. Asked of the server once (the list only), and chosen by the person: nothing is sent until they pick one. */
const freeModels: Preset = {
  label: "The free models of navvied.com",
  hint: "No account, no key. What you type goes to navvied.com, with a daily limit.",
  async configure(s) {
    const listing = await s.work("Asking navvied.com which models are free", { status: "Asking…" }, ({ signal }) => fetchGuestModels(s.io.fetch, DEFAULT_SERVER, AbortSignal.any([signal, AbortSignal.timeout(8000)])).catch(() => undefined));
    if (listing === "back") return "back";
    const usable = listing?.models.filter((m) => !m.locked) ?? [];
    if (!listing || !usable.length) { s.say("navvied.com did not offer free models just now. Check the connection, or choose another way."); return "back"; }
    const picked = usable.length === 1 ? 0 : await s.pick("Which model?", usable.map((m) => ({ label: m.name, ...(m.blurb ? { hint: m.blurb } : {}) })));
    if (picked === "back") return "back";
    const chosen = usable[picked]!;
    try { writeHostedModels(guestModelsPath(s.io.env), listing); } catch { /* the list is kept for next time when it can be */ }
    const entry = guestEntries(DEFAULT_SERVER, listing)[`${GUEST_PREFIX}${chosen.id}`];
    return entry ? { name: `${GUEST_PREFIX}${chosen.id}`, entry } : "back";
  },
};

export const PRESETS: Preset[] = [
  claudeSubscription,
  hosted(ANTHROPIC, "Claude, with an API key", "Pay per use. Nothing else to install."),
  codexSubscription,
  hosted(OPENAI, "GPT models, with an OpenAI API key", "Pay per use."),
  hosted(OPENROUTER, "Many models, with an OpenRouter key", "One key for hundreds of models."),
  { label: "A model on this computer", hint: "Ollama, LM Studio, llama.cpp or vLLM. Private and free.", configure: (s) => serverFlow(s, false, "Which server?") },
  { label: "Another service", hint: "Any address that speaks the OpenAI chat API.", configure: (s) => serverFlow(s, true, "Which server?") },
  otherProgram,
  freeModels,
];

/** The files a project may keep its standing instructions in. NAVVIED.md first; the others are read when it is absent, so projects set up for other agents work as they are. */
export const INSTRUCTION_FILE_NAMES: readonly string[] = ["NAVVIED.md", "AGENTS.md", "CLAUDE.md"];

/**
 * The effort levels a service takes, and where its request wants them, for the services whose own documentation says so. Left out when it
 * does not: a model with no levels listed shows only Auto, and a level that was never promised is never sent. Sources (read 2026-11-20):
 * Anthropic, platform.claude.com/docs/en/build-with-claude/effort (per-model levels; `output_config.effort` in the messages API);
 * DeepSeek, api-docs.deepseek.com/guides/thinking_mode (`reasoning_effort` low, high, max);
 * OpenRouter, openrouter.ai/docs/use-cases/reasoning-tokens (`reasoning.effort`: max, xhigh, high, medium, low, minimal, none).
 * OpenAI's own page says the levels depend on the model and lists them for only some of its newest ones, so none are listed for it.
 */
export function knownEffort(entry: { baseUrl?: string; model?: string; signIn?: { provider: string } }): { efforts: Effort[]; field?: "reasoning" } | undefined {
  let host = "";
  try { host = new URL(entry.baseUrl ?? "").hostname; } catch { /* not an address */ }
  const model = entry.model ?? "";
  if (host === "api.anthropic.com" || entry.signIn?.provider === "claude") {
    if (/^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(model) || /^claude-opus-4-[78]/.test(model)) return { efforts: ["low", "medium", "high", "xhigh", "max"] };
    if (/^claude-(opus|sonnet)-4-6/.test(model) || /^claude-mythos-preview/.test(model)) return { efforts: ["low", "medium", "high", "max"] };
    if (/^claude-opus-4-5/.test(model)) return { efforts: ["low", "medium", "high"] };
    return undefined;
  }
  if (host === "api.deepseek.com") return { efforts: ["low", "high", "max"] };
  if (host === "openrouter.ai") return { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], field: "reasoning" };
  return undefined;
}

/** The providers a person can use with a key of their own: what a screen draws and what the engine sends. */
export const PROVIDERS: readonly ProviderEntry[] = [
  { id: "lmstudio", name: "LM Studio", base: "http://localhost:1234/v1", keyOptional: true },
  { id: "deepseek", name: "DeepSeek", base: "https://api.deepseek.com", getKey: "https://platform.deepseek.com/api_keys" },
  { id: "openai", name: "OpenAI API", base: "https://api.openai.com/v1", fields: [{ id: "org", label: "Organization ID", header: "OpenAI-Organization" }, { id: "project", label: "Project ID", header: "OpenAI-Project" }], getKey: "https://platform.openai.com/settings/organization/api-keys" },
  { id: "anthropic", name: "Anthropic", base: "https://api.anthropic.com/v1", fields: [{ id: "workspace", label: "Workspace ID", ph: "Required with an API key that isn’t scoped to a workspace", header: "anthropic-workspace-id" }], api: "messages", getKey: "https://platform.claude.com/settings/keys" },
  { id: "gemini", name: "Gemini API", base: "https://generativelanguage.googleapis.com/v1beta/openai/", getKey: "https://aistudio.google.com/apikey" },
  { id: "azure", name: "Microsoft Foundry", base: "https://{resource}.services.ai.azure.com/openai/v1/", fields: [{ id: "resource", label: "Resource name", ph: "YOUR-RESOURCE-NAME", required: true }], keyHeader: "api-key" },
  { id: "huggingface", name: "Hugging Face", base: "https://router.huggingface.co/v1", fields: [{ id: "billTo", label: "Bill to organization", ph: "my-org-name", header: "X-HF-Bill-To" }], getKey: "https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained" },
  { id: "fireworks", name: "Fireworks AI", base: "https://api.fireworks.ai/inference/v1", getKey: "https://app.fireworks.ai/settings/users/api-keys" },
  { id: "openrouter", name: "OpenRouter", base: "https://openrouter.ai/api/v1", getKey: "https://openrouter.ai/keys" },
  { id: "novita", name: "Novita AI", base: "https://api.novita.ai/openai/v1", getKey: "https://novita.ai/settings/key-management" },
  { id: "vercel", name: "Vercel AI Gateway", base: "https://ai-gateway.vercel.sh/v1" },
  { id: "zai", name: "Z.AI", base: "https://api.z.ai/api/paas/v4", getKey: "https://z.ai/manage-apikey/apikey-list" },
  { id: "kimi", name: "Kimi", regions: [{ id: "intl", label: "International", base: "https://api.moonshot.ai/v1", keyUrl: "https://platform.kimi.ai/console/api-keys" }, { id: "cn", label: "China", base: "https://api.moonshot.cn/v1", keyUrl: "https://platform.kimi.com/console/api-keys" }] },
  { id: "gmi", name: "GMI Cloud", base: "https://api.gmi-serving.com/v1", getKey: "https://console.gmicloud.ai" },
  { id: "nebius", name: "Nebius Token Factory", base: "https://api.tokenfactory.nebius.com/v1/", getKey: "https://tokenfactory.nebius.com/project/api-keys" },
  { id: "actual", name: "Actual", base: "https://api.actual.inc/v1", fields: [{ id: "cluster", label: "Cluster ID", header: "X-Cluster-ID" }] },
  { id: "xai", name: "xAI", base: "https://api.x.ai/v1", getKey: "https://console.x.ai/team/default/api-keys" },
  { id: "alibaba", name: "Alibaba Cloud Model Studio", regions: [{ id: "sg", label: "Singapore", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key" }, { id: "us", label: "US (Virginia)", base: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" }, { id: "hk", label: "China (Hong Kong)", base: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1" }, { id: "cn", label: "China (Beijing)", base: "https://dashscope.aliyuncs.com/compatible-mode/v1" }], keyNote: "API Keys are region-specific." },
  { id: "kilo", name: "Kilo Code", base: "https://ai-gateway.kilo.ai/api/v1", fields: [{ id: "org", label: "Organization ID", ph: "your_org_id", header: "X-KiloCode-OrganizationId" }] },
  { id: "mimo", name: "Xiaomi MiMo", base: "https://api.xiaomimimo.com/v1", keyHeader: "api-key" },
  { id: "commandcode", name: "Command Code", base: "https://api.commandcode.ai/provider/v1", getKey: "https://commandcode.ai/settings/keys" },
  { id: "stepfun", name: "StepFun", regions: [{ id: "intl", label: "International", base: "https://api.stepfun.ai/v1", keyUrl: "https://platform.stepfun.ai/interface-key" }, { id: "cn", label: "China", base: "https://api.stepfun.com/v1", keyUrl: "https://platform.stepfun.com/interface-key" }] },
  { id: "meta", name: "Meta Model API", base: "https://api.meta.ai/v1", api: "responses" },
  { id: "deepinfra", name: "DeepInfra", base: "https://api.deepinfra.com/v1/openai" },
  { id: "together", name: "Together AI", base: "https://api.together.ai/v1", getKey: "https://api.together.ai/settings/projects/~current/api-keys" },
  { id: "groq", name: "Groq", base: "https://api.groq.com/openai/v1" },
  { id: "cerebras", name: "Cerebras", base: "https://api.cerebras.ai/v1", getKey: "https://cloud.cerebras.ai" },
  { id: "mistral", name: "Mistral AI", base: "https://api.mistral.ai/v1", getKey: "https://console.mistral.ai/api-keys" },
  { id: "bedrock", name: "Amazon Bedrock", base: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", fields: [{ id: "region", label: "Region", ph: "us-east-1", required: true }], keyLabel: "Amazon Bedrock API key" },
  { id: "upstage", name: "Upstage", base: "https://api.upstage.ai/v1" },
  { id: "ollama-cloud", name: "Ollama", base: "https://ollama.com/v1" },
  { id: "tokenhub", name: "Tencent TokenHub", regions: [{ id: "sg", label: "Singapore (Global)", base: "https://tokenhub-intl.tencentcloudmaas.com/v1" }, { id: "gz", label: "Guangzhou (Chinese mainland)", base: "https://tokenhub.tencentcloudmaas.com/v1" }, { id: "us", label: "Silicon Valley (United States)", base: "https://tokenhub-us.tencentcloudmaas.tech/v1" }] },
  { id: "mimo-plan", name: "Xiaomi MiMo Token Plan", regions: [{ id: "cn", label: "China Cluster", base: "https://token-plan-cn.xiaomimimo.com/v1" }, { id: "sgp", label: "Singapore Cluster", base: "https://token-plan-sgp.xiaomimimo.com/v1" }, { id: "ams", label: "European Cluster", base: "https://token-plan-ams.xiaomimimo.com/v1" }], keyHeader: "api-key" },
  { id: "ramp", name: "Router", base: "https://api.router.com/v1", api: "responses" },
  { id: "nvidia", name: "NVIDIA", base: "https://integrate.api.nvidia.com/v1" },
  { id: "perplexity", name: "Perplexity", base: "https://api.perplexity.ai/v1", api: "responses" },
  { id: "arcee", name: "Arcee", base: "https://api.arcee.ai/api/v1" },
  { id: "minimax", name: "MiniMax", base: "https://api.minimax.io/v1" },
  { id: "zai-plan", name: "GLM Coding Plan", base: "https://api.z.ai/api/coding/paas/v4" },
  { id: "tokenplan", name: "Tencent Token Plan", base: "https://tokenhub-intl.tencentcloudmaas.com/plan/v3", evidence: "community" },
  { id: "minimax-plan", name: "MiniMax Token Plan", regions: [{ id: "intl", label: "minimax.io", base: "https://api.minimax.io/anthropic/v1" }, { id: "cn", label: "minimax.cn", base: "https://api.minimax.cn/anthropic/v1" }], api: "messages", evidence: "community" },
  { id: "alibaba-coding", name: "Alibaba Coding Plan", regions: [{ id: "sg", label: "Singapore", base: "https://coding-intl.dashscope.aliyuncs.com/v1" }, { id: "cn", label: "China", base: "https://coding.dashscope.aliyuncs.com/v1" }], evidence: "community" },
  { id: "alibaba-token", name: "Alibaba Token Plan", regions: [{ id: "sg", label: "Singapore", base: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" }, { id: "cn", label: "China (Beijing)", base: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" }], evidence: "community" },
  { id: "opencode", name: "OpenCode Console", base: "https://opencode.ai/inference/openai/v1", routes: [{ protocol: "chat-completions", api: "chat" }, { protocol: "responses", api: "responses" }, { protocol: "messages", api: "messages" }], getKey: "https://opencode.ai/console" },
  { id: "opencode-go", name: "OpenCode Go", base: "https://opencode.ai/inference/go/openai/v1", routes: [{ protocol: "chat-completions", api: "chat" }, { protocol: "responses", api: "responses" }, { protocol: "messages", api: "messages" }], sessionHeader: "x-opencode-session" },
  { id: "vertex", name: "Vertex AI", base: "https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi", fields: [{ id: "project", label: "Project ID", ph: "PROJECT_ID", required: true }, { id: "location", label: "Location", ph: "global", required: true }], adc: { env: "GOOGLE_APPLICATION_CREDENTIALS", wellKnown: { posix: ".config/gcloud/application_default_credentials.json", windows: "gcloud\\application_default_credentials.json" }, tokenUri: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/cloud-platform" } },
];

/** How a person is told the way a server speaks, and what in its address hints at it (an endpoint of their own: see endpoints.ts). */
export const API_STYLES = {
  chat: { label: "OpenAI" },
  responses: { label: "OpenAI responses" },
  messages: { label: "Anthropic", path: /\/anthropic(\/|$)/ },
  ollama: { label: "Ollama", port: "11434" },
} as const satisfies Record<"chat" | "responses" | "messages" | "ollama", { label: string; path?: RegExp; port?: string }>;

/** Where models are searched and fetched from; the token for models that need a licence is the one saved for the provider of the same name. */
export const MODEL_HUB = { base: "https://huggingface.co", tokenProvider: "huggingface" } as const;

/**
 * The small models that are offered first to someone who has none: coding or instruct models whose chat template handles tools. A name is here only with a raw line
 * (2026-11-24, `GET /api/models/<repo>` of the hub, kept in the evidence notes) that shows the template names `tools` (`{%- if tools %}`), and the licence. The screens never
 * name a model: they ask for this list, which is then kept to what fits the computer and what the template still says. Best first.
 */
export const RECOMMENDED_MODELS = [
  { repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", kind: "coding", licence: "apache-2.0" },
  { repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", kind: "instruct", licence: "apache-2.0" },
  { repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", kind: "coding", licence: "apache-2.0" },
] as const;

/**
 * The program that runs a model on this computer, as one release of its project, pinned: every file has the SHA-256 that the release page's own API gave AND that was found again
 * by downloading the file (2026-11-24; the evidence is in the notes), and nothing that does not have it is ever run. `with` is the CUDA runtime that goes beside a CUDA build.
 * Moving to another release is a change of this table and nothing else.
 */
export const RUNTIME = {
  tag: "b12651",
  commit: "f5e6915c28f10330885fcb9243a93ae98d3115ab",
  base: "https://github.com/ggml-org/llama.cpp/releases/download",
  assets: [
    { os: "linux", arch: "x64", backend: "cpu", file: "llama-b12651-bin-ubuntu-x64.tar.gz", sha256: "17b242259181d5b1b1f7719aba27929700a8b0dab39bfaef1b971a992b397b38", size: 23297838 },
    { os: "linux", arch: "x64", backend: "vulkan", file: "llama-b12651-bin-ubuntu-vulkan-x64.tar.gz", sha256: "0bbcf2093f15c64c8a9bf54b809c9b2c812b982992dc2fbc9b36720c1d32cf13", size: 36976824 },
    { os: "linux", arch: "x64", backend: "cuda12", file: "llama-b12651-bin-ubuntu-cuda-12.8-x64.tar.gz", sha256: "cb099350c6a025e67eefaa13f2b67b2dcce53e38a0da22476e070d166ef367ea", size: 220195495, with: { file: "cudart-llama-b12651-bin-ubuntu-cuda-12.8-x64.tar.gz", sha256: "485df8f0b0ab30c15807d25fd23a821aeaef62a3947722c683429491a5e0d027", size: 594371475 } },
    { os: "linux", arch: "x64", backend: "cuda13", file: "llama-b12651-bin-ubuntu-cuda-13.5-x64.tar.gz", sha256: "78ffa8d39ee0e54108a33b9f81affca3748e4e1d079d7d8b03368ab6986c6c76", size: 224478514, with: { file: "cudart-llama-b12651-bin-ubuntu-cuda-13.5-x64.tar.gz", sha256: "73bd842d8d178f2ad7a8053eb218a94e0ba9e991965584d0b7af9135cde2d7c6", size: 444078776 } },
    { os: "linux", arch: "arm64", backend: "cpu", file: "llama-b12651-bin-ubuntu-arm64.tar.gz", sha256: "b4a8d17e16a1b42f6a1395dc5cd6967ec0d98005eb3be85b7eb893b082306ed4", size: 18813487 },
    { os: "linux", arch: "arm64", backend: "vulkan", file: "llama-b12651-bin-ubuntu-vulkan-arm64.tar.gz", sha256: "138f97d9d448b7a55c4b839366bba6e2ac7fba634f9160c9a4775a2051a1c7cb", size: 29928246 },
    { os: "macos", arch: "arm64", backend: "metal", file: "llama-b12651-bin-macos-arm64.tar.gz", sha256: "264fd872de61679c45ad57e1e21c2a2a54e29b35734ecf3d50f24166447ab8d2", size: 16644358 },
    { os: "macos", arch: "x64", backend: "cpu", file: "llama-b12651-bin-macos-x64.tar.gz", sha256: "34c19771545479a783d3b68c446383ab703033890c052d3ff0b860a5c9f59e56", size: 12434934 },
    { os: "windows", arch: "x64", backend: "cpu", file: "llama-b12651-bin-win-cpu-x64.zip", sha256: "b2d794fa7587aba29f654d717ff9b73e31caeabf50a7766692903008bbe0855d", size: 25096571 },
    { os: "windows", arch: "x64", backend: "vulkan", file: "llama-b12651-bin-win-vulkan-x64.zip", sha256: "e58fa9a137d8046c69334005ad6fb3e904ddc7e56f2a61ad1b844335826ef3f4", size: 38939211 },
    { os: "windows", arch: "x64", backend: "cuda12", file: "llama-b12651-bin-win-cuda-12.4-x64.zip", sha256: "1a6c090f76fab41260b5b7597c6fb1add1fad2efaac692ae2673a22366220a29", size: 358031654, with: { file: "cudart-llama-bin-win-cuda-12.4-x64.zip", sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6", size: 391443627 } },
    { os: "windows", arch: "x64", backend: "cuda13", file: "llama-b12651-bin-win-cuda-13.5-x64.zip", sha256: "5ad87e0771f3a129f6461b5fc706d8c2c5e5b71b2bd1f953a4221ca4d7797fef", size: 225702093, with: { file: "cudart-llama-bin-win-cuda-13.5-x64.zip", sha256: "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba", size: 426314199 } },
    { os: "windows", arch: "arm64", backend: "cpu", file: "llama-b12651-bin-win-cpu-arm64.zip", sha256: "756a62761e476536f007c866d46fa14125f6ca32d98cee6af14685659bd9f244", size: 13190749 },
    { os: "windows", arch: "arm64", backend: "vulkan", file: "llama-b12651-bin-win-vulkan-arm64.zip", sha256: "430849ca03a2a891baa90091670df45f29b90c2ec445aab2ad7d830ff423303c", size: 26601338 },
  ],
} as const satisfies import("./runtime.ts").RuntimePin;

/**
 * The oldest driver of the card's maker that a build of the runtime for its toolkit runs with, from the maker's own table of toolkits and drivers (the notes have the raw lines):
 * the 12.x builds of the release are made with 12.8 (Linux) and 12.4 (Windows), whose first drivers are these; the 13.5 build needs the branch of its toolkit.
 */
export const RUNTIME_DRIVERS = { cuda12: { linux: "570.26", windows: "551.61" }, cuda13: { linux: "620", windows: "620" } } as const;
