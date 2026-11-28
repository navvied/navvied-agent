import { entryEnvOf } from "../src/programs.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateCommand } from "@navvied/protocol";
import type { EngineEvent } from "@navvied/protocol";
import { accounts, readAccounts } from "../src/accounts.ts";
import { CLAUDE_INSTALL, installPlan } from "../src/programs.ts";
import { createHub } from "../src/commands/hub.ts";
import { accountPath, configPath } from "../src/config.ts";
import { fakeIO, fakeSystem, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const hubs: { stop(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(hubs.map((h) => h.stop())); dirs.forEach(remove); });

const CLAUDE = "/bin/claude", CODEX = "/bin/codex";
const SIGNED = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com", subscriptionType: "max" });

/** A computer with these programs, each answering what a real one answers to the two questions that are asked of it. */
const system = (o: { claude?: boolean; codex?: boolean; claudeSigned?: boolean; codexSigned?: boolean; npm?: boolean } = {}) => fakeSystem({
  installed: { ...(o.claude ? { claude: CLAUDE } : {}), ...(o.codex ? { codex: CODEX } : {}), ...(o.npm ? { npm: "/bin/npm" } : {}) },
  runs: {
    [`${CLAUDE} --version`]: async () => ({ code: 0, output: "2.1.320 (Claude Code)" }),
    [`${CLAUDE} auth status --json`]: async () => ({ code: 0, output: o.claudeSigned ? SIGNED : JSON.stringify({ loggedIn: false }) }),
    [`${CODEX} --version`]: async () => ({ code: 0, output: "codex-cli 0.9.1" }),
    [`${CODEX} login status`]: async () => (o.codexSigned ? { code: 0, output: "Logged in using ChatGPT" } : { code: 1, output: "Not logged in" }),
  },
});

/** The installer of Claude as this computer runs it: the sh line, or the PowerShell line on Windows. */
const CLAUDE_ARGV = process.platform === "win32" ? ["powershell", "-NoProfile", "-Command", CLAUDE_INSTALL.windows] : ["sh", "-c", CLAUDE_INSTALL.unix];
const CLAUDE_RUN = CLAUDE_ARGV.join(" ");

const fakeAccount = { server: "https://example.test", token: "t-secret", email: "owner@example.com" };

describe("what the accounts say", () => {
  test("nothing installed: the navvied account as it is, the two programs as not installed, and no program is run", async () => {
    const sys = system();
    const items = await readAccounts(fakeIO({ system: sys }).io, undefined, { models: {} });
    expect(items).toEqual([{ id: "navvied", signedIn: false }, { id: "claude-code", installed: false }, { id: "codex", installed: false }]);
    expect(sys.ran).toEqual([]);
  });

  test("installed and signed in: what each program itself says, and only its version and its status are asked", async () => {
    const sys = system({ claude: true, codex: true, claudeSigned: true, codexSigned: true });
    const items = await readAccounts(fakeIO({ system: sys }).io, fakeAccount, { models: {} });
    expect(items).toEqual([
      { id: "navvied", signedIn: true, email: "owner@example.com" },
      { id: "claude-code", installed: true, version: "2.1.320", signedIn: true, email: "me@example.com", plan: "max" },
      { id: "codex", installed: true, version: "0.9.1", signedIn: true },
    ]);
    expect(sys.ran.map((a) => a.join(" ")).sort()).toEqual([`${CLAUDE} --version`, `${CLAUDE} auth status --json`, `${CODEX} --version`, `${CODEX} login status`].sort());
    expect(JSON.stringify(items)).not.toContain("t-secret");
  });

  test("installed and not signed in: no email and no plan, whatever the program printed", async () => {
    const items = await readAccounts(fakeIO({ system: system({ claude: true, codex: true }) }).io, undefined, { models: {} });
    expect(items[1]).toEqual({ id: "claude-code", installed: true, version: "2.1.320", signedIn: false });
    expect(items[2]).toEqual({ id: "codex", installed: true, version: "0.9.1", signedIn: false });
  });

  test("a program that does not answer is installed, with no version, and not signed in", async () => {
    const sys = fakeSystem({ installed: { claude: CLAUDE } });
    expect(await readAccounts(fakeIO({ system: sys }).io, undefined, { models: {} })).toEqual([{ id: "navvied", signedIn: false }, { id: "claude-code", installed: true, signedIn: false }, { id: "codex", installed: false }]);
  });
});

describe("what a page may send", () => {
  test("the two commands, and only the programs that have an installer", () => {
    expect(validateCommand({ cmd: "accounts" }).ok).toBe(true);
    expect(validateCommand({ cmd: "account.install", id: "codex" }).ok).toBe(true);
    expect(validateCommand({ cmd: "account.install", id: "claude-code" }).ok).toBe(true);
    for (const id of ["rm -rf", "a/b", "", 3, undefined]) expect(validateCommand({ cmd: "account.install", id }).ok).toBe(false);
  });
});

function page(sys: ReturnType<typeof fakeSystem>, o: { cloud?: boolean } = {}) {
  const told: EngineEvent[] = [];
  const io = fakeIO({ system: sys }).io;
  const a = accounts({ io, inCloud: () => !!o.cloud, account: () => undefined, tell: (e) => told.push(e), models: { save: () => undefined, remove: () => undefined, entries: () => ({ models: {} }) }, session: { paths: () => ({ account: "/nowhere/account.json", models: "/nowhere/models.json" }), server: () => "https://example.test", label: () => "My computer", changed: () => undefined } });
  return { told, send: (cmd: object) => a.command(cmd as never), of: (ev: string) => told.filter((e) => e.ev === ev) as Record<string, unknown>[] };
}

describe("installing a program", () => {
  test("Claude Code: the official installer is run, and the accounts are said again with the program there", async () => {
    const sys = system();
    sys.runs[CLAUDE_RUN] = async () => { sys.installed.claude = CLAUDE; return { code: 0, output: "" }; };
    const p = page(sys);
    expect(p.send({ cmd: "account.install", id: "claude-code" })).toBe(true);
    await until(() => p.of("accounts").length === 1);
    expect(p.of("account.install").map((e) => e.state)).toEqual(["installing", "done"]);
    expect(sys.ran[0]).toEqual(CLAUDE_ARGV);
    expect((p.of("accounts")[0]!.items as { id: string; installed?: boolean }[]).find((i) => i.id === "claude-code")!.installed).toBe(true);
  });

  test("Codex: npm into the person's own folder; without npm it is said, and nothing is run", async () => {
    const without = page(system());
    without.send({ cmd: "account.install", id: "codex" });
    await until(() => without.of("account.install").length === 1);
    expect(without.of("account.install")[0]).toMatchObject({ state: "failed" });
    expect(String(without.of("account.install")[0]!.error)).toContain("npm was not found");
    const sys = system({ npm: true });
    sys.runs["/bin/npm install -g"] = async () => { sys.installed.codex = CODEX; return { code: 0, output: "" }; };
    const p = page(sys);
    p.send({ cmd: "account.install", id: "codex" });
    await until(() => p.of("accounts").length === 1);
    expect(p.of("account.install").map((e) => e.state)).toEqual(["installing", "done"]);
    expect(sys.ran[0]!.slice(0, 3)).toEqual(["/bin/npm", "install", "-g"]);
    expect(sys.ran[0]).toContain("@openai/codex");
  });

  test("an installer that fails, or leaves no program, is said in words; two asks at once run it once", async () => {
    const sys = system();
    let runs = 0;
    sys.runs[CLAUDE_RUN] = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return { code: 1, output: "" }; };
    const p = page(sys);
    p.send({ cmd: "account.install", id: "claude-code" });
    p.send({ cmd: "account.install", id: "claude-code" });
    await until(() => p.of("account.install").some((e) => e.state === "failed"));
    expect(runs).toBe(1);
    expect(String(p.of("account.install").find((e) => e.state === "failed")!.error)).toContain("did not finish");
  });
});

describe("the installer of Claude on each system", () => {
  test("Windows runs PowerShell's own installer, everything else runs sh", () => {
    const none = () => undefined;
    expect(installPlan("claude-code", "win32", {}, none)).toMatchObject({ argv: ["powershell", "-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"] });
    for (const platform of ["linux", "darwin"] as const) expect(installPlan("claude-code", platform, {}, none)).toMatchObject({ argv: ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"] });
  });
});

describe("a program that is not in the list", () => {
  test("is said not to be known, and nothing is run", async () => {
    const sys = system();
    const p = page(sys);
    p.send({ cmd: "account.install", id: "navvied" });
    await until(() => p.of("account.install").length === 1);
    expect(p.of("account.install")[0]).toMatchObject({ state: "failed", error: "That program is not known." });
    expect(sys.ran).toEqual([]);
  });
});

describe("in Navvied Cloud", () => {
  test("both are refused and nothing is run", async () => {
    const sys = system({ claude: true });
    const p = page(sys, { cloud: true });
    p.send({ cmd: "accounts" });
    p.send({ cmd: "account.install", id: "claude-code" });
    expect(p.of("error")).toHaveLength(2);
    expect(String(p.of("error")[0]!.msg)).toContain("never in Navvied Cloud");
    expect(sys.ran).toEqual([]);
  });
});

describe("through the hub", () => {
  test("the page asks and is told, with the navvied account read from this computer's own file", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
    mkdirSync(dirname(configPath(env)), { recursive: true });
    writeFileSync(configPath(env), JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } } }));
    mkdirSync(dirname(accountPath(env)), { recursive: true });
    writeFileSync(accountPath(env), `${JSON.stringify(fakeAccount)}\n`);
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env, system: system({ codex: true, codexSigned: true }) }).io, { watch: false, import: false });
    hubs.push(hub);
    const got: { ev: string; items?: unknown[] }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    hub.command(JSON.stringify({ cmd: "accounts" }), () => undefined);
    await until(() => got.some((e) => e.ev === "accounts"));
    expect(got.find((e) => e.ev === "accounts")!.items).toEqual([{ id: "navvied", signedIn: true, email: "owner@example.com" }, { id: "claude-code", installed: false }, { id: "codex", installed: true, version: "0.9.1", signedIn: true }]);
  });
});

describe("asking a program about its sign-in", () => {
  test("it sees its own sign-in variables and what its entry sets under env, from the entries of that program only", async () => {
    const calls: { argv: string[]; keep?: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
    const sys = { ...system({ claude: true, codex: true }), run: async (argv: string[], options?: { keep?: readonly string[]; env?: Readonly<Record<string, string>> }) => { calls.push({ argv, ...options }); return { code: 0, output: "{}" }; } };
    await readAccounts(fakeIO({ system: sys }).io, undefined, { models: { mine: { command: "/bin/claude", env: { CLOUD_ACCOUNT_KEY: "from-the-entry" } }, other: { command: "agent-cli", env: { OTHER_KEY: "not-for-them" } } } });
    const asked = (program: string) => calls.find((c) => c.argv[0]!.includes(program) && c.argv.includes("status"))!;
    expect(asked("claude").env).toEqual({ CLOUD_ACCOUNT_KEY: "from-the-entry" });
    expect(asked("claude").keep).toContain("ANTHROPIC_API_KEY");
    expect(asked("codex").env).toEqual({});
    expect(asked("codex").keep).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("two entries of one program", () => {
  const models = { work: { command: "/bin/claude", env: { CLAUDE_CONFIG_DIR: "/work", ANTHROPIC_API_KEY: "work-key" } }, home: { command: "/bin/claude", env: { CLAUDE_CONFIG_DIR: "/home" } }, api: { baseUrl: "http://127.0.0.1:1/v1", model: "x" } };

  test("are never mixed: the one in use is asked, whole; with none of them in use, the first", () => {
    expect(entryEnvOf({ models, inUse: "home" }, "claude-code")).toEqual({ CLAUDE_CONFIG_DIR: "/home" });
    expect(entryEnvOf({ models, inUse: "work" }, "claude-code")).toEqual({ CLAUDE_CONFIG_DIR: "/work", ANTHROPIC_API_KEY: "work-key" });
    for (const inUse of [undefined, "api", "gone"]) expect(entryEnvOf({ models, inUse }, "claude-code"), String(inUse)).toEqual({ CLAUDE_CONFIG_DIR: "/work", ANTHROPIC_API_KEY: "work-key" });
    expect(entryEnvOf({ models, inUse: "home" }, "codex")).toEqual({});
  });
});
