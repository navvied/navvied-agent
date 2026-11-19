import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikeKey } from "../src/system.ts";
import { loadConfig } from "../src/config.ts";
import { main } from "../src/main.ts";
import { fakeIO, fakeSystem, remove, tempDir, type FakeSystem } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => dirs.forEach(remove));

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

interface World {
  /** Ports with a model server on them, and the models each lists. */
  local?: Record<number, string[]>;
  /** The context length an Ollama model reports. */
  memory?: number;
  /** What the services answer to a model list: by host. */
  services?: Record<string, { status?: number; ids?: string[]; seen?: Headers[] }>;
  system?: FakeSystem;
  env?: Record<string, string>;
}

function setup(stdin: string, world: World = {}) {
  const state = tmp();
  const config = join(state, "config.json");
  const system = world.system ?? fakeSystem();
  const seen: { url: string; headers: Headers }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    const local = world.local?.[Number(/127\.0\.0\.1:(\d+)\//.exec(url)?.[1])];
    if (url.endsWith("/models") && local) return Response.json({ data: local.map((id) => ({ id })) });
    if (url.endsWith("/api/tags") && local) return Response.json({ models: local.map((name) => ({ name })) });
    if (url.endsWith("/api/show") && local) return Response.json({ model_info: { "llama.context_length": world.memory ?? 131072 } });
    const service = Object.entries(world.services ?? {}).find(([host]) => url.includes(host))?.[1];
    if (service && url.endsWith("/models")) return service.status && service.status !== 200 ? new Response("{}", { status: service.status }) : Response.json({ data: (service.ids ?? []).map((id) => ({ id })) });
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const f = fakeIO({ interactive: true, stdin, system, fetch: fetchFn, env: { HOME: state, XDG_STATE_HOME: state, PATH: process.env.PATH ?? "", ...world.env } });
  return { f, config, state, system, seen };
}

const KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OPENAI_KEY = "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("recognising a key", () => {
  test("it must start the way the service's keys do, be one word, and be long enough", () => {
    expect(looksLikeKey(KEY, "sk-ant-")).toBe(true);
    expect(looksLikeKey("sk-ant-short", "sk-ant-")).toBe(false);
    expect(looksLikeKey(`${KEY} and more`, "sk-ant-")).toBe(false);
    expect(looksLikeKey("hello world, this is text", "sk-ant-")).toBe(false);
    expect(looksLikeKey(undefined, "sk-ant-")).toBe(false);
  });
});

describe("a model on this computer", () => {
  test("pick the server's model from its own list; the file is private and the server is checked", async () => {
    const { f, config } = setup("6\n2\n", { local: { 11434: ["small", "large"] } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Found 1 server running on this computer.");
    expect(f.err()).toContain("✓ the model server answered");
    expect(read(config)).toEqual({ default: "large", models: { large: { baseUrl: "http://127.0.0.1:11434", api: "ollama", model: "large", window: 16384 } } });
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  test("Ollama gets the most memory the model supports, up to 16384, and 8192 when unknown", async () => {
    const small = setup("6\n1\n", { local: { 11434: ["m"] }, memory: 4096 });
    expect(await main(["init", "--config", small.config], small.f.io)).toBe(0);
    expect(read(small.config).models.m.window).toBe(4096);
  });
  test("other local servers keep the chat address", async () => {
    const { f, config } = setup("6\n1\n", { local: { 1234: ["c"] } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(read(config).models.c).toEqual({ baseUrl: "http://127.0.0.1:1234/v1", model: "c", reasoning: "none", window: 32768 });
  });

  test("a running server is the preselected choice, so Enter and Enter is all it takes", async () => {
    const { f, config } = setup("\n\n", { local: { 11434: ["only"] } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(read(config).default).toBe("only");
  });

  test("several servers are listed by name, with their model counts", async () => {
    const { f, config } = setup("6\n2\n1\n", { local: { 11434: ["a", "b"], 1234: ["c"] } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Ollama on this computer");
    expect(f.err()).toContain("LM Studio on this computer");
    expect(f.err()).toContain("http://127.0.0.1:1234/v1   1 model");
    expect(read(config).models.c.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  test("no server running: it says so, goes back to the list, and nothing is saved", async () => {
    const { f, config } = setup("6\n");
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("No model server was found on this computer");
    expect(f.err()).toContain("setup cancelled");
    expect(existsSync(config)).toBe(false);
  });
});

describe("another service", () => {
  test("detected servers are offered first, and an address is typed only as the last choice", async () => {
    const { f, config } = setup("7\n2\nhttp://10.0.0.5:8000/v1\n2\nmy-model\n", { local: { 1234: ["c"] } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("LM Studio on this computer");
    expect(f.err()).toContain("A server at another address");
    expect(read(config).models["my-model"]).toEqual({ baseUrl: "http://10.0.0.5:8000/v1", model: "my-model", window: 128000 });
  });

  test("a bad address is explained and asked for again", async () => {
    const { f, config } = setup("7\n\nnot-an-address\nhttp://10.0.0.5:8000/v1\n2\nmy-model\n");
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("That does not look like an address");
    expect(Object.keys(read(config).models)).toEqual(["my-model"]);
  });

  test("a server that wants a key is asked for one, and the model list is then read with it", async () => {
    const world: World = { services: { "secure.example": { status: 401 } } };
    const state = setup("", world);
    state.f.io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      return String(input).includes("secure.example") && auth === "Bearer tok-123" ? Response.json({ data: [{ id: "m1" }] }) : new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const f = fakeIO({ interactive: true, stdin: "7\n\nhttps://secure.example/v1\ntok-123\n1\n", fetch: state.f.io.fetch, env: { HOME: state.state } });
    expect(await main(["init", "--config", state.config], f.io)).toBe(0);
    expect(read(state.config).models.m1).toEqual({ baseUrl: "https://secure.example/v1", model: "m1", window: 128000, apiKey: "tok-123" });
  });
});

describe("Claude, with an API key", () => {
  const services = { "api.anthropic.com": { ids: ["claude-opus-5-5", "claude-sonnet-5-5"] } };

  test("a key in the clipboard is offered first; the models come from the account and the key goes in the right headers", async () => {
    const { f, config, seen } = setup("2\n1\n2\n", { services, system: fakeSystem({ clip: KEY }) });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Use the key in my clipboard");
    expect(f.err()).toContain(`Found a key starting with sk-ant- (${KEY.length} characters). Stored only on this computer.`);
    const asked = seen.find((s) => s.url.startsWith("https://api.anthropic.com/v1/models"))!;
    expect(asked.headers.get("x-api-key")).toBe(KEY);
    expect(asked.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(read(config).models["claude-sonnet-5-5"]).toEqual({ baseUrl: "https://api.anthropic.com/v1", api: "messages", model: "claude-sonnet-5-5", window: 200000, apiKey: KEY });
    if (process.platform !== "win32") expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  test("a key already in the environment can be used without being stored", async () => {
    const { f, config } = setup("2\n1\n1\n", { services, env: { ANTHROPIC_API_KEY: KEY } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Use the key from ANTHROPIC_API_KEY");
    const saved = read(config).models["claude-opus-5-5"];
    expect(saved.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(readFileSync(config, "utf8")).not.toContain(KEY);
  });

  test("with nothing to offer, the page where keys are made opens in the browser and the list says what to do", async () => {
    const system = fakeSystem();
    const { f, config } = setup(`2\n1\n2\n${KEY}\n1\n`, { services, system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(system.opened).toEqual(["https://console.anthropic.com/settings/keys"]);
    expect(f.err()).toContain("Waiting for a key in your clipboard");
    expect(read(config).models["claude-opus-5-5"].apiKey).toBe(KEY);
  });

  test("a key the service refuses is explained, and the choice of key comes back", async () => {
    const world: World = { services: { "api.anthropic.com": { status: 401 } }, system: fakeSystem({ clip: KEY }) };
    const { f, config } = setup("2\n1\n", world);
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("Anthropic did not accept that key (401). Check it and try again.");
    expect((f.err().match(/Your API key/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(config)).toBe(false);
  });

  test("when the service cannot list its models, the person can try again or type the name", async () => {
    const { f, config } = setup(`2\n1\n2\nmy-model\n`, { services: { "api.anthropic.com": { status: 500 } }, system: fakeSystem({ clip: KEY }) });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("The server did not send its list of models");
    expect(f.err()).toContain("Try again");
    expect(read(config).models["my-model"].model).toBe("my-model");
  });
});

describe("typing a model name", () => {
  test("an address typed where a model name is wanted is refused, with the way a model name looks", async () => {
    const { f, config } = setup("7\n\nhttp://10.0.0.5:8000/v1\n2\nhttp://10.0.0.5:8000/v1\n2\nreal-model\n");
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("That is an address, not a model name.");
    expect(read(config).models["real-model"].model).toBe("real-model");
  });
});

describe("other services with a key", () => {
  test("an OpenAI key is recognised, an Anthropic key in the clipboard is not mistaken for one, and only chat models are listed", async () => {
    const services = { "api.openai.com": { ids: ["text-embedding-3", "gpt-4o", "whisper-1"] } };
    const wrong = setup("4\n1\n1\n", { services, system: fakeSystem({ clip: KEY }), env: { OPENAI_API_KEY: OPENAI_KEY } });
    expect(await main(["init", "--config", wrong.config], wrong.f.io)).toBe(0);
    expect(wrong.f.err()).not.toContain("Use the key in my clipboard");
    expect(wrong.f.err()).toContain("Use the key from OPENAI_API_KEY");
    const right = setup("4\n1\n1\n", { services, system: fakeSystem({ clip: OPENAI_KEY }) });
    expect(await main(["init", "--config", right.config], right.f.io)).toBe(0);
    expect(read(right.config).models["gpt-4o"]).toEqual({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", window: 128000, apiKey: OPENAI_KEY });
    expect(right.f.err()).not.toContain("whisper");
    expect(right.seen.find((s) => s.url.includes("openai"))!.headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
  });

  test("an OpenRouter key, from its own page", async () => {
    const key = "sk-or-v1-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const system = fakeSystem({ clip: key });
    const { f, config } = setup("5\n1\n1\n", { services: { "openrouter.ai": { ids: ["some/model"] } }, system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(read(config).models["some-model"].baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("Claude, with your subscription", () => {
  const claude = "/usr/local/bin/claude";
  const status = (state: { loggedIn: boolean }) => () => ({ code: 0, output: JSON.stringify({ loggedIn: state.loggedIn, authMethod: state.loggedIn ? "claude.ai" : "none", ...(state.loggedIn ? { email: "ana@example.com" } : {}) }) });

  test("an installed program that is already signed in is detected, with its version and account", async () => {
    const state = { loggedIn: true };
    const system = fakeSystem({ installed: { claude }, runs: { [`${claude} --version`]: () => ({ code: 0, output: "2.1.325 (Claude Code)\n" }), [`${claude} auth status`]: status(state) } });
    const { f, config } = setup("1\n1\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Claude Code is ready");
    expect(f.err()).toContain("Claude Code 2.1.325, signed in with your Claude subscription (ana@example.com).");
    const saved = read(config).models.claude;
    expect(saved).toMatchObject({ command: claude, window: 200000, efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(saved.model).toBeUndefined();
    expect(saved.models.map((m: { id: string }) => m.id)).toEqual(["default", "opus", "sonnet", "haiku"]);
    expect(f.err()).toContain("Which Claude model?");
  });

  test("the model chosen after signing in is kept, and 'let it choose' leaves the program to decide", async () => {
    const state = { loggedIn: true };
    const system = fakeSystem({ installed: { claude }, runs: { [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }), [`${claude} auth status`]: status(state) } });
    const { f, config } = setup("1\n1\n2\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(read(config).models.claude.model).toBe("opus");
    expect(f.err()).toContain("The most capable. Uses your plan faster.");
  });

  test("going back from the model list returns to the sign-in choice", async () => {
    const state = { loggedIn: true };
    const system = fakeSystem({ installed: { claude }, runs: { [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }), [`${claude} auth status`]: status(state) } });
    const { f, config } = setup("1\n1\nback\n1\n1\n", { system });
    await main(["init", "--config", config], f.io);
    expect(f.err().split("Which Claude model?").length).toBeGreaterThan(2);
  });

  test("not signed in: it offers the two kinds of sign-in, runs the program's own login, and goes on when it is done", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { claude }, runs: {
      [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }),
      [`${claude} auth status`]: status(state),
      [`${claude} auth login`]: (_argv, on) => { on("Opening browser to sign in…"); state.loggedIn = true; return { code: 0, output: "" }; },
    } });
    const { f, config } = setup("1\n1\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Claude Code 2.1.325 was found on this computer.");
    expect(f.err()).toContain("Sign in with my Claude subscription");
    expect(f.err()).toContain("Sign in with an Anthropic Console account");
    expect(system.ran).toContainEqual([claude, "auth", "login", "--claudeai"]);
    expect(read(config).models.claude.command).toBe(claude);
  });

  test("the Console account uses the Console login", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { claude }, runs: { [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }), [`${claude} auth status`]: status(state), [`${claude} auth login`]: () => { state.loggedIn = true; return { code: 0, output: "" }; } } });
    const { f, config } = setup("1\n2\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(system.ran).toContainEqual([claude, "auth", "login", "--console"]);
  });

  test("a code from the browser is typed into the program's own sign-in, and the sign-in finishes when it accepts it", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { claude }, runs: {
      [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }),
      [`${claude} auth status`]: status(state),
      [`${claude} auth login`]: (_argv, on, input) => new Promise((resolve) => {
        on("Opening browser to sign in…");
        on("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc");
        on("Paste code here if prompted >");
        input.onLine((line) => { if (line === "CODE-123") { state.loggedIn = true; resolve({ code: 0, output: "" }); } });
      }),
    } });
    const { f, config } = setup("1\n1\n1\nCODE-123\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("I have a code from the browser");
    expect(f.err()).toContain("Paste the code from the browser");
    expect(read(config).models.claude.command).toBe(claude);
  });

  test("a code the program does not accept is explained, and the field comes back for another try", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { claude }, runs: {
      [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }),
      [`${claude} auth status`]: status(state),
      [`${claude} auth login`]: (_argv, _on, input) => new Promise((resolve) => { input.onLine((line) => { if (line === "RIGHT") { state.loggedIn = true; resolve({ code: 0, output: "" }); } }); }),
    } });
    const { f, config } = setup("1\n1\n1\nWRONG\nRIGHT\n\n", { system, env: { NAVVIED_CODE_WAIT_MS: "60" } });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Claude Code did not accept that code. It may have expired.");
    expect(system.ran.filter((a) => a.includes("login"))).toHaveLength(1);
  });

  test("the address of the sign-in page can be shown, and the page opened again in the browser", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { claude }, runs: {
      [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }),
      [`${claude} auth status`]: status(state),
      [`${claude} auth login`]: (_argv, on, input) => new Promise((resolve) => {
        on("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=xyz");
        input.onLine((line) => { if (line === "OK") { state.loggedIn = true; resolve({ code: 0, output: "" }); } });
      }),
    } });
    const { f, config } = setup("1\n1\n3\n2\n1\nOK\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("https://claude.com/cai/oauth/authorize?state=xyz");
    expect(system.opened).toEqual(["https://claude.com/cai/oauth/authorize?state=xyz"]);
  });

  test("a sign-in that is not finished is explained and the choice comes back", async () => {
    const system = fakeSystem({ installed: { claude }, runs: { [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }), [`${claude} auth status`]: status({ loggedIn: false }), [`${claude} auth login`]: () => ({ code: 1, output: "" }) } });
    const { f, config } = setup("1\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("The sign-in was not finished");
    expect((f.err().match(/Sign in with my Claude subscription/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(config)).toBe(false);
  });

  test("not installed: it offers to install, shows the command first, and does nothing unless told to", async () => {
    const system = fakeSystem();
    const { f, config } = setup("1\n1\n2\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("Claude Code is not installed on this computer");
    expect(f.err()).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(f.err()).toContain("Run this command?");
    expect(system.ran).toEqual([]);
    expect(existsSync(config)).toBe(false);
  });

  test("not installed, and the person would rather do it themselves: the commands for every system are shown", async () => {
    const { f } = setup("1\n2\n", { system: fakeSystem() });
    await main(["init", "--config", join(tmp(), "c.json")], f.io);
    expect(f.err()).toContain("curl -fsSL https://claude.ai/install.sh | bash   (macOS and Linux)");
    expect(f.err()).toContain("irm https://claude.ai/install.ps1 | iex   (Windows)");
  });

  test("installing runs the installer, finds the program afterwards, and carries on to the sign-in", async () => {
    if (process.platform === "win32") return;
    const state = { loggedIn: false };
    const system = fakeSystem({ runs: {
      "sh -c curl -fsSL https://claude.ai/install.sh | bash": (_argv, on) => { on("Downloading…"); system.installed.claude = claude; return { code: 0, output: "" }; },
      [`${claude} --version`]: () => ({ code: 0, output: "2.1.325" }),
      [`${claude} auth status`]: status(state),
      [`${claude} auth login`]: () => { state.loggedIn = true; return { code: 0, output: "" }; },
    } });
    const { f, config } = setup("1\n1\n1\n1\n\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(system.ran[0]).toEqual(["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
    expect(read(config).models.claude.command).toBe(claude);
  });

  test("an installer that fails, or leaves no program behind, is reported plainly", async () => {
    if (process.platform === "win32") return;
    const system = fakeSystem({ runs: { "sh -c": () => ({ code: 0, output: "" }) } });
    const { f, config } = setup("1\n1\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("The installer did not finish, or claude was not found afterwards");
  });
});

describe("Codex, with your ChatGPT plan", () => {
  const codex = "/usr/local/bin/codex";
  const status = (state: { loggedIn: boolean }) => () => (state.loggedIn ? { code: 0, output: "Logged in using ChatGPT\n" } : { code: 1, output: "Not logged in\n" });
  const version = { [`${codex} --version`]: () => ({ code: 0, output: "codex-cli 0.169.0\n" }) };

  test("an installed program that is signed in is detected, with its version and how it is signed in", async () => {
    const system = fakeSystem({ installed: { codex }, runs: { ...version, [`${codex} login status`]: status({ loggedIn: true }) } });
    const { f, config } = setup("3\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Codex is ready");
    expect(f.err()).toContain("Codex 0.169.0, signed in with your ChatGPT account.");
    expect(read(config)).toEqual({ default: "codex", models: { codex: { command: codex, adapter: "codex", window: 200000, efforts: ["low", "medium", "high", "xhigh"] } } });
  });

  test("not signed in: the browser sign-in runs the program's own login and goes on when it reports a login", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { codex }, runs: { ...version, [`${codex} login status`]: status(state), [`${codex} login`]: (_a, on) => { on("Starting local login server on http://localhost:1455."); state.loggedIn = true; return { code: 0, output: "" }; } } });
    const { f, config } = setup("3\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Codex 0.169.0 was found on this computer.");
    expect(f.err()).toContain("Sign in with my ChatGPT account");
    expect(f.err()).toContain("Sign in from another device");
    expect(system.ran).toContainEqual([codex, "login"]);
    expect(read(config).models.codex.adapter).toBe("codex");
  });

  test("from another device: the address and the one-time code are read from the program's own words and shown, in colour or not", async () => {
    const state = { loggedIn: false };
    const system = fakeSystem({ installed: { codex }, runs: { ...version, [`${codex} login status`]: status(state), [`${codex} login --device-auth`]: (_a, on) => new Promise((resolve) => {
      on("Welcome to Codex [v\u001b[90m0.169.0\u001b[0m]");
      on("1. Open this link in your browser and sign in to your account");
      on("   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m");
      on("2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m");
      on("   \u001b[94mJRZE-T13ML\u001b[0m");
      setTimeout(() => { state.loggedIn = true; resolve({ code: 0, output: "" }); }, 60);
    }) } });
    const { f, config } = setup("3\n2\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Sign in from another device");
    expect(read(config).models.codex.command).toBe(codex);
  });

  test("from another device, when the program gives no code, the person is told and sent back", async () => {
    const system = fakeSystem({ installed: { codex }, runs: { ...version, [`${codex} login status`]: status({ loggedIn: false }), [`${codex} login --device-auth`]: () => ({ code: 1, output: "" }) } });
    const { f, config } = setup("3\n2\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("Codex did not give a code to enter.");
    expect(existsSync(config)).toBe(false);
  });

  test("a browser sign-in that ends without a login is explained and the choice comes back", async () => {
    const system = fakeSystem({ installed: { codex }, runs: { ...version, [`${codex} login status`]: status({ loggedIn: false }), [`${codex} login`]: () => ({ code: 1, output: "" }) } });
    const { f, config } = setup("3\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("The sign-in was not finished.");
    expect((f.err().match(/Sign in with my ChatGPT account/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("not installed, with npm: the command is shown first, nothing runs unless it is accepted, and then it installs and carries on", async () => {
    if (process.platform === "win32") return;
    const state = { loggedIn: true };
    const decline = fakeSystem({ installed: { npm: "/usr/bin/npm" } });
    const a = setup("3\n1\n2\n", { system: decline });
    expect(await main(["init", "--config", a.config], a.f.io)).toBe(2);
    expect(a.f.err()).toContain("npm install -g --prefix ~/.local @openai/codex");
    expect(a.f.err()).toContain("so it needs no administrator password");
    expect(decline.ran).toEqual([]);
    const system = fakeSystem({ installed: { npm: "/usr/bin/npm" }, runs: {
      "/usr/bin/npm install": (_a, on) => { on("added 2 packages"); system.installed.codex = codex; return { code: 0, output: "" }; },
      ...version, [`${codex} login status`]: status(state),
    } });
    const b = setup("3\n1\n1\n1\n", { system });
    expect(await main(["init", "--config", b.config], b.f.io)).toBe(0);
    expect(system.ran[0]!.slice(0, 5)).toEqual(["/usr/bin/npm", "install", "-g", "--prefix", `${b.state}/.local`]);
    expect(system.ran[0]!.at(-1)).toBe("@openai/codex");
  });

  test("not installed, and no npm: only the do-it-yourself choice is offered, with the other ways to get it", async () => {
    const { f } = setup("3\n1\n", { system: fakeSystem() });
    await main(["init", "--config", join(tmp(), "c.json")], f.io);
    expect(f.err()).toContain("navvied needs npm to install Codex for you, and npm was not found on this computer.");
    expect(f.err()).toContain("brew install codex");
  });

  test("an install that fails or leaves no program is reported plainly", async () => {
    if (process.platform === "win32") return;
    const system = fakeSystem({ installed: { npm: "/usr/bin/npm" }, runs: { "/usr/bin/npm install": () => ({ code: 1, output: "EACCES" }) } });
    const { f, config } = setup("3\n1\n1\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("The installer did not finish, or codex was not found afterwards");
  });
});

describe("other programs", () => {
  test("programs found on the computer are listed with where they are and their version; one is chosen", async () => {
    const system = fakeSystem({ installed: { claude: "/bin/claude", codex: "/opt/codex" }, runs: { "/bin/claude --version": () => ({ code: 0, output: "2.1.325" }), "/opt/codex --version": () => ({ code: 0, output: "codex-cli 0.52.0" }) } });
    const { f, config } = setup("8\n2\n", { system });
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain("Found 2 programs on this computer that can work as an agent.");
    expect(f.err()).toContain("Found at /opt/codex, version 0.52.0");
    expect(read(config).models.codex).toEqual({ command: "/opt/codex", window: 200000 });
  });

  test("a program that is not in the list is typed as the last choice, with a note when it is not found", async () => {
    const { f, config } = setup("8\n\nnot-a-real-program-xyz\n");
    expect(await main(["init", "--config", config], f.io)).toBe(0);
    expect(f.err()).toContain('"not-a-real-program-xyz" was not found on your PATH');
    expect(read(config).models["not-a-real-program-xyz"].command).toBe("not-a-real-program-xyz");
  });

});

describe("saving", () => {
  test("adding to an existing file keeps the other models; the default changes only if you say so", async () => {
    const world = { local: { 11434: ["new-model"] } };
    const keep = setup("6\n1\n2\n", world);
    writeFileSync(keep.config, JSON.stringify({ default: "old", models: { old: { baseUrl: "http://h/v1", model: "o" } } }));
    expect(await main(["init", "--config", keep.config], keep.f.io)).toBe(0);
    expect(Object.keys(read(keep.config).models).sort()).toEqual(["new-model", "old"]);
    expect(read(keep.config).default).toBe("old");
    const change = setup("6\n1\n1\n", world);
    writeFileSync(change.config, JSON.stringify({ default: "old", models: { old: { baseUrl: "http://h/v1", model: "o" } } }));
    await main(["init", "--config", change.config], change.f.io);
    expect(read(change.config).default).toBe("new-model");
  });

  test("it needs a terminal, and refuses to overwrite a damaged configuration", async () => {
    const plain = fakeIO({ env: {} });
    expect(await main(["init"], plain.io)).toBe(2);
    expect(plain.err()).toContain("needs a terminal");
    const { f, config } = setup("1\n");
    writeFileSync(config, "{broken");
    expect(await main(["init", "--config", config], f.io)).toBe(2);
    expect(f.err()).toContain("Fix or remove that file");
    expect(readFileSync(config, "utf8")).toBe("{broken");
  });

  test("what it writes is a valid configuration that the program accepts, including the API kind", async () => {
    const { f, config } = setup("2\n1\n1\n", { services: { "api.anthropic.com": { ids: ["m1"] } }, system: fakeSystem({ clip: KEY }) });
    await main(["init", "--config", config], f.io);
    const loaded = loadConfig(config);
    expect(loaded.ok && loaded.value!.models.m1!.api).toBe("messages");
  });
});

describe("how a connected model is described", () => {
  test("in plain words: on this computer, hosted, or through a program", async () => {
    const { describeEntry } = await import("../src/create.ts");
    expect(describeEntry({ baseUrl: "http://localhost:1234/v1" })).toBe("On this computer.");
    expect(describeEntry({ baseUrl: "https://x.example/v1" })).toBe("A hosted service.");
    expect(describeEntry({ baseUrl: "nonsense" })).toBe("A hosted service.");
    expect(describeEntry({ command: "x" })).toBe("Through a program you are signed in to.");
    expect(describeEntry({ command: "x", adapter: "codex" })).toBe("Through your ChatGPT plan.");
  });
});
