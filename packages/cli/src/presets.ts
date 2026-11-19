import { loginStoreFor } from "./logins.ts";
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
  window: number;
  headers(key: string): Record<string, string>;
  keep?(id: string): boolean;
}

const ANTHROPIC: Service = {
  name: "Anthropic", env: "ANTHROPIC_API_KEY", prefix: "sk-ant-", page: "https://console.anthropic.com/settings/keys",
  baseUrl: "https://api.anthropic.com/v1", api: "messages", window: 200_000,
  headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
};

const OPENAI: Service = {
  name: "OpenAI", env: "OPENAI_API_KEY", prefix: "sk-", not: ["sk-ant-", "sk-or-"], page: "https://platform.openai.com/api-keys",
  baseUrl: "https://api.openai.com/v1", window: 128_000, headers: (key) => ({ authorization: `Bearer ${key}` }),
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
      return { name: slug(model), entry: { baseUrl: svc.baseUrl, ...(svc.api ? { api: svc.api } : {}), model, window: svc.window, ...key } };
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
    return { name: "claude", entry: { api: "messages", baseUrl: "https://api.anthropic.com/v1", model: CLAUDE_NATIVE[chosen.id] ?? "claude-sonnet-5-5", signIn: { provider: "claude" }, window: 200_000, display: { name: chosen.id === "default" ? "Claude" : `Claude ${chosen.name}` } } };
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
        ? { name: "codex", entry: { api: "responses", baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5.5", signIn: { provider: "chatgpt" }, window: 200_000, display: { name: "ChatGPT" } } }
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
