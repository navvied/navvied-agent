import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, createAccount, fetchModels, signIn } from "../src/account-client.ts";
import { clearAccount, hostedEntries, readAccount, readHostedModels, writeAccount, writeHostedModels, type HostedModels } from "../src/account.ts";
import { accountPath, hostedModelsPath, loadConfig, resolveModel } from "../src/config.ts";
import type { Choice, Frame, IO } from "../src/io.ts";
import { login, signOutScreen } from "../src/login-ui.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-login-"));
afterAll(hook("login removes what it made", async () => { await removeTree(dir); }));
let n = 0;
const fresh = (): string => { const d = join(dir, `c${n++}`); mkdirSync(d, { recursive: true }); return d; };

const listing: HostedModels = {
  default: "sage",
  models: [
    { id: "sage", name: "Raphael Sage", brand: "raphael", badge: "FREE", blurb: "Free and private.", api: "chat", window: 32000, reasoning: "none" },
    { id: "apex", name: "Raphael Apex", brand: "raphael", badge: "MAX", efforts: ["low", "high"], api: "messages", window: 200000, reasoning: "effort" },
    { id: "plus", name: "Jarvis Plus", locked: true, api: "chat", window: 64000, reasoning: "none" },
  ],
};
const account = { server: "https://example.test", token: "nv_secret", email: "you@example.com" };

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("the saved account", () => {
  test("is kept in a file only its owner can read, and forgotten on sign-out", () => {
    const file = join(fresh(), "account.json");
    writeAccount(file, account);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readAccount(file)).toEqual(account);
    clearAccount(file);
    expect(readAccount(file)).toBeUndefined();
  });
  test("a damaged or empty file is no account", () => {
    const file = join(fresh(), "account.json");
    writeFileSync(file, "{ nope");
    expect(readAccount(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ server: "x", token: "", email: "e" }));
    expect(readAccount(file)).toBeUndefined();
  });
  test("the models become ordinary entries named by their brand, with the token as the key and the real model never in them", () => {
    const entries = hostedEntries(account, listing);
    expect(Object.keys(entries)).toEqual(["navvied-sage", "navvied-apex", "navvied-plus"]);
    expect(entries["navvied-apex"]).toMatchObject({ baseUrl: "https://example.test/v1", api: "messages", model: "apex", apiKey: "nv_secret", window: 200000, reasoning: "effort", efforts: ["low", "high"], display: { name: "Raphael Apex", brand: "raphael", badge: "MAX" } });
    expect(entries["navvied-plus"]!.display).toMatchObject({ locked: true });
    const file = join(fresh(), "models.json");
    writeHostedModels(file, listing);
    expect(readHostedModels(file)).toEqual(listing);
  });
});

describe("the account in the model list", () => {
  const setup = (own?: object, signedIn = true) => {
    const d = fresh();
    const env = { XDG_CONFIG_HOME: join(d, "cfg"), XDG_STATE_HOME: join(d, "state") };
    const path = join(d, "cfg", "navvied", "config.json");
    mkdirSync(join(d, "cfg", "navvied"), { recursive: true });
    if (own) writeFileSync(path, JSON.stringify(own));
    if (signedIn) { writeAccount(accountPath(env), account); mkdirSync(join(d, "state", "navvied"), { recursive: true }); writeHostedModels(hostedModelsPath(env), listing); }
    return { env, path };
  };
  const mine = { models: { local: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen" } } };

  test("someone with only an account has the models and the server's default chosen", () => {
    const { env, path } = setup();
    const file = loadConfig(path, env);
    expect(file.ok && Object.keys(file.value!.models)).toEqual(["navvied-sage", "navvied-apex", "navvied-plus"]);
    const resolved = resolveModel(undefined, file.ok ? file.value : null, env, path);
    expect(resolved.ok && resolved.value.name).toBe("navvied-sage");
    expect(resolved.ok && resolved.value.provider).toMatchObject({ baseUrl: "https://example.test/v1", model: "sage", apiKey: "nv_secret" });
  });
  test("a person's own single model stays the one used, and the hosted ones are added beside it", () => {
    const { env, path } = setup(mine);
    const file = loadConfig(path, env);
    expect(file.ok && Object.keys(file.value!.models)).toEqual(["navvied-sage", "navvied-apex", "navvied-plus", "local"]);
    const resolved = resolveModel(undefined, file.ok ? file.value : null, env, path);
    expect(resolved.ok && resolved.value.name).toBe("local");
  });
  test("a default the person set is kept", () => {
    const { env, path } = setup({ ...mine, default: "navvied-apex" });
    const file = loadConfig(path, env);
    expect(file.ok && file.value!.default).toBe("navvied-apex");
  });
  test("signed out, or asked without the environment, nothing changes", () => {
    const out = setup(mine, false);
    const file = loadConfig(out.path, out.env);
    expect(file.ok && Object.keys(file.value!.models)).toEqual(["local"]);
    const inn = setup(mine);
    const bare = loadConfig(inn.path);
    expect(bare.ok && Object.keys(bare.value!.models)).toEqual(["local"]);
    expect(loadConfig(out.path.replace("config.json", "none.json"), out.env)).toEqual({ ok: true, value: null });
  });
  test("an account whose list was never fetched adds nothing yet", () => {
    const d = fresh();
    const env = { XDG_CONFIG_HOME: join(d, "cfg"), XDG_STATE_HOME: join(d, "state") };
    mkdirSync(join(d, "cfg", "navvied"), { recursive: true });
    writeAccount(accountPath(env), account);
    expect(loadConfig(join(d, "cfg", "navvied", "config.json"), env)).toEqual({ ok: true, value: null });
  });
});

describe("talking to the server", () => {
  const say = (res: () => Response | Promise<Response>) => (async () => res()) as unknown as typeof fetch;

  test("signing in gives the token and sends the password only to the sign-in path", async () => {
    const sent: { url: string; body: string }[] = [];
    const send = (async (url: string, init: RequestInit) => { sent.push({ url, body: String(init.body) }); return reply(200, { user: { email: "you@example.com" }, token: "nv_abc" }); }) as unknown as typeof fetch;
    expect(await signIn(send, "https://example.test/", "you@example.com", "pw-12345678", "this computer")).toEqual({ server: "https://example.test", token: "nv_abc", email: "you@example.com" });
    expect(sent[0]!.url).toBe("https://example.test/api/account/token");
    expect(JSON.parse(sent[0]!.body)).toEqual({ email: "you@example.com", password: "pw-12345678", name: "this computer" });
  });
  test("every failure is a plain sentence the person can act on", async () => {
    const msg = async (f: typeof fetch, run: (f: typeof fetch) => Promise<unknown>) => run(f).then(() => "no error", (e: unknown) => (e instanceof AccountError ? e.message : `WRONG ERROR ${String(e)}`));
    const wrong = say(() => reply(401, { error: { message: "Invalid email or password.", type: "authentication" } }));
    expect(await msg(wrong, (f) => signIn(f, "https://example.test", "a@b.cc", "x", "l"))).toBe("Invalid email or password.");
    expect(await msg(say(() => reply(409, { error: { message: "An account with this email already exists.", type: "conflict" } })), (f) => createAccount(f, "https://example.test", "a@b.cc", "12345678"))).toBe("An account with this email already exists.");
    expect(await msg(say(() => reply(429, {}, { "retry-after": "900" })), (f) => signIn(f, "https://example.test", "a@b.cc", "x", "l"))).toBe("Too many tries. Wait 15 minutes and try again.");
    expect(await msg(say(() => reply(502, "x")), (f) => signIn(f, "https://example.test", "a@b.cc", "x", "l"))).toBe("The server answered 502. Try again in a moment.");
    expect(await msg((async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }) as unknown as typeof fetch, (f) => signIn(f, "https://example.test", "a@b.cc", "x", "l"))).toBe("Could not reach example.test. Check your internet connection and try again.");
    expect(await msg(say(() => reply(401, {})), (f) => fetchModels(f, account))).toBe("You were signed out of your navvied account. Type /login to sign in again.");
  });
  test("the model list is read with the token", async () => {
    let auth = "";
    const send = (async (url: string, init: RequestInit) => { auth = String((init.headers as Record<string, string>).authorization); return reply(200, { default: "sage", data: listing.models }); }) as unknown as typeof fetch;
    expect(await fetchModels(send, account)).toEqual(listing);
    expect(auth).toBe("Bearer nv_secret");
  });
});

/** A terminal that answers the menus and questions from a script, and remembers what it was shown. */
function terminal(script: { choose?: (number | undefined)[]; text?: (string | undefined)[]; secret?: (string | undefined)[] }, send: typeof fetch) {
  const shown: { kind: string; title: string; notice?: string[]; items?: string[]; heading?: string[]; body?: string[]; status?: string; actions?: NonNullable<Frame["actions"]> }[] = [];
  const opened: string[] = [];
  const logged: string[] = [];
  const copied: string[] = [];
  const queue = { choose: [...(script.choose ?? [])], text: [...(script.text ?? [])], secret: [...(script.secret ?? [])] };
  const io = {
    color: false, fetch: send, interactive: true,
    choose: async (title: string, items: Choice[], _i?: number, frame?: Frame) => { shown.push({ kind: "choose", title, items: items.map((i) => i.label), ...(frame?.notice ? { notice: frame.notice } : {}), ...(frame?.heading ? { heading: frame.heading } : {}) }); return queue.choose.shift(); },
    text: async (title: string, _i?: string, frame?: Frame) => { shown.push({ kind: "text", title, ...(frame?.notice ? { notice: frame.notice } : {}) }); return queue.text.shift(); },
    secret: async (title: string, frame?: Frame) => { shown.push({ kind: "secret", title, ...(frame?.notice ? { notice: frame.notice } : {}) }); return queue.secret.shift(); },
    work: async <T>(title: string, f: Frame, task: (context: { log(line: string): void; signal: AbortSignal }) => Promise<T>) => { shown.push({ kind: "work", title, ...(f.body ? { body: f.body } : {}), ...(f.status ? { status: f.status } : {}), ...(f.actions ? { actions: f.actions } : {}) }); return task({ log(line: string) { logged.push(line); }, signal: new AbortController().signal }); },
    system: { open: (url: string) => { opened.push(url); }, copy: async (text: string) => { copied.push(text); return true; } },
  } as unknown as IO;
  return { io, shown, opened, logged, copied };
}

describe("the /login screens", () => {
  const server = (log: string[] = []) => (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    log.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/account/token" && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { password: string };
      return body.password === "right-password" ? reply(200, { user: { email: "you@example.com" }, token: "nv_new" }) : reply(401, { error: { message: "Invalid email or password.", type: "authentication" } });
    }
    if (path === "/api/account/register") return reply(201, { user: { email: "new@example.com" } });
    if (path === "/v1/models") return reply(200, { default: "sage", data: listing.models });
    if (path === "/api/account/token" && init.method === "DELETE") return reply(200, { ok: true });
    return reply(404, {});
  }) as unknown as typeof fetch;
  const paths = () => { const d = fresh(); return { account: join(d, "account.json"), models: join(d, "state", "hosted-models.json") }; };

  test("signing in asks for the email and the password, shows progress, saves the account and says which models are ready", async () => {
    const log: string[] = [];
    const p = paths();
    const t = terminal({ choose: [1], text: ["You@Example.com"], secret: ["right-password"] }, server(log));
    const outcome = await login(t.io, p, undefined, "https://example.test");
    expect(outcome).toEqual({ kind: "signed-in", email: "you@example.com", models: ["Raphael Sage", "Raphael Apex"] });
    expect(t.shown.map((s) => `${s.kind}:${s.title}`)).toEqual(["choose:What would you like to do?", "text:Your email address", "secret:Your password", "work:Signing in…"]);
    expect(readAccount(p.account)).toEqual({ server: "https://example.test", token: "nv_new", email: "you@example.com" });
    expect(readHostedModels(p.models)).toEqual(listing);
    expect(log).toEqual(["POST /api/account/token", "GET /v1/models"]);
    expect(readFileSync(p.account, "utf8")).not.toContain("right-password");
  });
  test("a wrong password returns to the menu with the reason, and the person can try again", async () => {
    const p = paths();
    const t = terminal({ choose: [1, 1], text: ["you@example.com", "you@example.com"], secret: ["bad", "right-password"] }, server());
    const outcome = await login(t.io, p, undefined, "https://example.test");
    expect(outcome.kind).toBe("signed-in");
    const menus = t.shown.filter((s) => s.kind === "choose");
    expect(menus[1]!.notice).toEqual(["Invalid email or password."]);
    expect(menus[0]!.notice).toBeUndefined();
  });
  test("an email that cannot be right is caught before anything is sent", async () => {
    const log: string[] = [];
    const t = terminal({ choose: [1], text: ["nope", undefined] }, server(log));
    expect(await login(t.io, paths(), undefined, "https://example.test")).toEqual({ kind: "cancelled" });
    expect(t.shown.filter((s) => s.kind === "text")[1]!.notice).toEqual(["That does not look like an email address. For example: you@example.com"]);
    expect(log).toEqual([]);
  });
  test("making an account asks for the password twice, refuses a short or different one, then signs in", async () => {
    const log: string[] = [];
    const p = paths();
    const t = terminal({ choose: [2], text: ["new@example.com"], secret: ["short", "right-password", "different", "right-password", "right-password"] }, server(log));
    const outcome = await login(t.io, p, undefined, "https://example.test");
    expect(outcome.kind).toBe("signed-in");
    const secrets = t.shown.filter((s) => s.kind === "secret");
    expect(secrets[1]!.notice).toEqual(["Use at least 8 characters."]);
    expect(secrets.some((s) => s.notice?.[0]?.startsWith("The two passwords were not the same"))).toBe(true);
    expect(log).toEqual(["POST /api/account/register", "POST /api/account/token", "GET /v1/models"]);
  });
  test("Not now, Esc and going back leave without saving anything", async () => {
    const p = paths();
    expect(await login(terminal({ choose: [3] }, server()).io, p, undefined, "https://example.test")).toEqual({ kind: "cancelled" });
    expect(await login(terminal({ choose: [undefined] }, server()).io, p, undefined, "https://example.test")).toEqual({ kind: "cancelled" });
    expect(await login(terminal({ choose: [1, 3], text: ["back"] }, server()).io, p, undefined, "https://example.test")).toEqual({ kind: "cancelled" });
    expect(existsSync(p.account)).toBe(false);
  });
  test("signed in, the menu offers the models, signing out, or staying", async () => {
    const p = paths();
    expect(await login(terminal({ choose: [0] }, server()).io, p, account, "x")).toEqual({ kind: "choose-model" });
    expect(await login(terminal({ choose: [2] }, server()).io, p, account, "x")).toEqual({ kind: "cancelled" });
    const t = terminal({ choose: [0] }, server());
    await login(t.io, p, account, "x");
    expect(t.shown[0]!.items).toEqual(["Choose a model", "Sign out", "Stay signed in"]);
    expect(t.shown[0]!.heading!.join(" ")).toContain("you@example.com");
  });
  test("signing out asks first, cancels the token on the server, and forgets the account and the list", async () => {
    const log: string[] = [];
    const p = paths();
    writeAccount(p.account, account);
    mkdirSync(join(p.models, ".."), { recursive: true });
    writeHostedModels(p.models, listing);
    expect(await signOutScreen(terminal({ choose: [1] }, server(log)).io, account, p)).toEqual({ kind: "cancelled" });
    expect(existsSync(p.account)).toBe(true);
    expect(await signOutScreen(terminal({ choose: [0] }, server(log)).io, account, p)).toEqual({ kind: "signed-out" });
    expect(existsSync(p.account)).toBe(false);
    expect(existsSync(p.models)).toBe(false);
    expect(log).toEqual(["DELETE /api/account/token"]);
  });
  test("a computer that cannot reach the server still signs out", async () => {
    const p = paths();
    writeAccount(p.account, account);
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await signOutScreen(terminal({ choose: [0] }, offline).io, account, p)).toEqual({ kind: "signed-out" });
    expect(existsSync(p.account)).toBe(false);
  });
});

describe("signing in through the browser", () => {
  const device = { deviceCode: "dev-secret", userCode: "BCDF-GHJK", verificationUrl: "https://example.test/device?code=BCDF-GHJK", expiresIn: 600, interval: 2 };
  /** A server whose approval comes after `pending` polls, then answers with `final`. */
  const server = (pending: number, final: "approved" | "denied" | "expired" | "down", log: string[] = []) => {
    let polls = 0;
    return (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      log.push(`${init.method ?? "GET"} ${path}`);
      if (path === "/api/account/device") return final === "down" ? reply(502, {}) : reply(200, device);
      if (path === "/api/account/device/token") {
        if (polls++ < pending) return reply(400, { error: { type: "authorization_pending" } });
        if (final === "denied") return reply(403, { error: { type: "denied" } });
        if (final === "expired") return reply(410, { error: { type: "expired" } });
        return reply(200, { user: { email: "you@example.com" }, token: "nv_browser" });
      }
      if (path === "/v1/models") return reply(200, { default: "sage", data: listing.models });
      return reply(404, {});
    }) as unknown as typeof fetch;
  };
  const paths = () => { const d = fresh(); return { account: join(d, "account.json"), models: join(d, "state", "hosted-models.json") }; };
  const fast = (waits: number[]) => async (ms: number): Promise<void> => { waits.push(ms); };

  test("opens the page, shows the code and the address, waits, and signs in once approved", async () => {
    const log: string[] = [], waits: number[] = [];
    const p = paths();
    const t = terminal({ choose: [0] }, server(2, "approved", log));
    const outcome = await login(t.io, p, undefined, "https://example.test", fast(waits));
    expect(outcome).toEqual({ kind: "signed-in", email: "you@example.com", models: ["Raphael Sage", "Raphael Apex"] });
    expect(t.opened).toEqual(["https://example.test/device?code=BCDF-GHJK"]);
    const waiting = t.shown.find((s) => s.kind === "work")!;
    expect(waiting.title).toBe("Approve in your browser");
    expect(waiting.body!.join("\n")).toContain("BCDF-GHJK");
    expect(waiting.body!.join("\n")).toContain("https://example.test/device?code=BCDF-GHJK");
    expect(waiting.status).toBe("Waiting for you to approve in the browser");
    expect(waits).toEqual([2000, 2000, 2000]);
    expect(log).toEqual(["POST /api/account/device", "POST /api/account/device/token", "POST /api/account/device/token", "POST /api/account/device/token", "GET /v1/models"]);
    expect(readAccount(p.account)).toEqual({ server: "https://example.test", token: "nv_browser", email: "you@example.com" });
    expect(readHostedModels(p.models)).toEqual(listing);
  });
  test("while waiting, O opens the page again and C copies the link, and each says what it did", async () => {
    const t = terminal({ choose: [0] }, server(1, "approved"));
    let pressed = false;
    const wait = async (): Promise<void> => {
      if (pressed) return;
      pressed = true;
      const actions = t.shown.find((s) => s.kind === "work")!.actions!;
      expect(actions.map((a) => a.key)).toEqual(["o", "c"]);
      actions[0]!.run();
      actions[1]!.run();
      await Promise.resolve();
    };
    await login(t.io, paths(), undefined, "https://example.test", wait);
    expect(t.opened).toEqual([device.verificationUrl, device.verificationUrl]);
    expect(t.copied).toEqual([device.verificationUrl]);
    expect(t.logged).toContain("Opened the page again.");
    expect(t.logged).toContain("Link copied. Paste it into any browser.");
  });
  test("turning it down, a code that ran out and a server that is down come back to the menu with the reason", async () => {
    for (const [final, notice] of [["denied", "You turned this down in the browser."], ["expired", "The code ran out. Choose Sign in to get a new one."]] as const) {
      const p = paths();
      const t = terminal({ choose: [0, 3] }, server(0, final));
      expect(await login(t.io, p, undefined, "https://example.test", fast([]))).toEqual({ kind: "cancelled" });
      expect(t.shown.filter((s) => s.kind === "choose")[1]!.notice).toEqual([notice]);
      expect(existsSync(p.account)).toBe(false);
    }
    const down = terminal({ choose: [0, 3] }, server(0, "down"));
    expect(await login(down.io, paths(), undefined, "https://example.test", fast([]))).toEqual({ kind: "cancelled" });
    expect(down.shown.filter((s) => s.kind === "choose")[1]!.notice).toEqual(["The server answered 502. Try again in a moment."]);
    expect(down.opened).toEqual([]);
  });
  test("the person can still choose email and password, or a new account, from the same menu", async () => {
    const t = terminal({ choose: [3] }, server(0, "approved"));
    await login(t.io, paths(), undefined, "https://example.test", fast([]));
    expect(t.shown[0]!.items).toEqual(["Sign in with my browser", "Sign in with email and password", "Create a free account", "Not now"]);
  });
  test("Esc on the waiting screen leaves without signing in", async () => {
    const t = terminal({ choose: [0] }, server(0, "approved"));
    (t.io as unknown as { work: unknown }).work = async () => undefined;
    const p = paths();
    expect(await login(t.io, p, undefined, "https://example.test", fast([]))).toEqual({ kind: "cancelled" });
    expect(existsSync(p.account)).toBe(false);
  });
});
