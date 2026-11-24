import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import type { ModelEntry } from "../src/config.ts";
import { accounts } from "../src/accounts.ts";
import { fakeIO, fakeSystem, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

const CLAUDE = "/bin/claude", CODEX = "/bin/codex";

/**
 * A computer with the programs, whose own sign-in the test controls: what the program prints while it waits for the browser, when it reports a login, and when it ends.
 * `login` is whether a saved login of the program exists on this computer (the home folder holds one or not).
 */
function computer(o: { claude?: boolean; codex?: boolean; login?: boolean; cloud?: boolean } = {}) {
  const home = tempDir();
  dirs.push(home);
  if (o.login) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1 } }));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
  }
  const state = { signedIn: false, polls: 0, signInAfter: 3, ends: false, typed: [] as string[], aborted: false };
  const sys = fakeSystem({ installed: { ...(o.claude !== false ? { claude: CLAUDE } : {}), ...(o.codex ? { codex: CODEX } : {}) } });
  const login = (lines: string[]) => (argv: string[], on: (line: string) => void, input: { onLine(l: (line: string) => void): void }) => {
    input.onLine((line) => state.typed.push(line));
    for (const l of lines) on(l);
    return new Promise<{ code: number; output: string }>((done) => {
      const timer = setInterval(() => { if (state.ends || state.signedIn) { clearInterval(timer); done({ code: state.signedIn ? 0 : 1, output: "" }); } }, 5);
    });
  };
  const status = async () => { state.polls++; if (state.polls >= state.signInAfter) state.signedIn = true; return { code: 0, output: JSON.stringify({ loggedIn: state.signedIn }) }; };
  sys.runs[`${CLAUDE} auth login --claudeai`] = login(["Opening browser to sign in…", "If the browser did not open, visit: https://claude.example/oauth/authorize?code=1"]);
  sys.runs[`${CLAUDE} auth status --json`] = status;
  sys.runs[`${CLAUDE} --version`] = async () => ({ code: 0, output: "2.1.320" });
  sys.runs[`${CODEX} login --device-auth`] = login(["Open this link: https://codex.example/device", "Enter this one-time code: ABCD-EFGH"]);
  sys.runs[`${CODEX} login status`] = async () => { state.polls++; if (state.polls >= state.signInAfter) state.signedIn = true; return state.signedIn ? { code: 0, output: "Logged in using ChatGPT" } : { code: 1, output: "Not logged in" }; };
  sys.runs[`${CODEX} --version`] = async () => ({ code: 0, output: "0.9.1" });
  const saved = new Map<string, ModelEntry>();
  const removed: string[] = [];
  const told: EngineEvent[] = [];
  const io = fakeIO({ env: { HOME: home }, system: sys }).io;
  const a = accounts({
    io, inCloud: () => !!o.cloud, account: () => undefined, tell: (e) => told.push(e),
    models: { save: (name, entry) => { saved.set(name, entry); }, remove: (name) => { removed.push(name); } },
    session: { paths: () => ({ account: join(home, "account.json"), models: join(home, "models.json") }), server: () => "https://example.test", label: () => "x", changed: () => { told.push({ ev: "notice", msg: "models changed" }); }, wait: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); } },
  });
  return { state, saved, removed, told, sys, send: (cmd: object) => a.command(cmd as never), of: (ev: string) => told.filter((e) => e.ev === ev) as Record<string, unknown>[] };
}

describe("signing in to a program from the page", () => {
  test("Claude: the address is said, the program is asked until it reports a login, and the entry is written as the setup writes it (the saved login is read, so navvied runs the work itself)", async () => {
    const c = computer({ login: true });
    c.send({ cmd: "account.signin", id: "claude-code" });
    await until(() => c.of("accounts").length === 1);
    expect(c.of("account.signin").map((e) => e.state)).toEqual(["waiting", "done"]);
    expect(c.of("account.signin")[0]).toMatchObject({ id: "claude-code", url: "https://claude.example/oauth/authorize?code=1" });
    expect(c.sys.ran[0]).toEqual([CLAUDE, "auth", "login", "--claudeai"]);
    expect([...c.saved.keys()]).toEqual(["claude"]);
    expect(c.saved.get("claude")).toMatchObject({ api: "messages", signIn: { provider: "claude" }, model: "claude-sonnet-5-5", display: { name: "Claude" } });
    expect(c.of("notice").length).toBeGreaterThan(0);
  });

  test("Claude with no login to read: the entry runs the program itself, as the setup writes it", async () => {
    const c = computer();
    c.send({ cmd: "account.signin", id: "claude-code" });
    await until(() => c.of("accounts").length === 1);
    expect(c.saved.get("claude")).toMatchObject({ command: CLAUDE, window: 200_000 });
    expect(c.saved.get("claude")).not.toHaveProperty("signIn");
  });

  test("a code the page shows is given to the program, and nothing else is typed", async () => {
    const c = computer();
    c.state.signInAfter = 1000;
    c.send({ cmd: "account.signin", id: "claude-code" });
    await until(() => c.of("account.signin").length === 1);
    c.send({ cmd: "account.signin.code", id: "claude-code", code: "abc-123" });
    expect(c.state.typed).toEqual(["abc-123"]);
    c.send({ cmd: "account.signin.cancel", id: "claude-code" });
    await until(() => c.of("account.signin").some((e) => e.state === "stopped"));
  });

  test("Codex from another device: the address and the code are said together", async () => {
    const c = computer({ codex: true, login: true });
    c.send({ cmd: "account.signin", id: "codex", device: true });
    await until(() => c.of("accounts").length === 1);
    expect(c.of("account.signin")[0]).toMatchObject({ id: "codex", state: "waiting", url: "https://codex.example/device", code: "ABCD-EFGH" });
    expect(c.sys.ran[0]).toEqual([CODEX, "login", "--device-auth"]);
    expect(c.saved.get("codex")).toMatchObject({ api: "responses", signIn: { provider: "chatgpt" }, display: { name: "ChatGPT" } });
  });

  test("a program that ends without a login, one that is not installed and one that is not known are each said in words, and nothing is written", async () => {
    const c = computer();
    c.state.signInAfter = 1000;
    c.send({ cmd: "account.signin", id: "claude-code" });
    await until(() => c.of("account.signin").length === 1);
    c.state.ends = true;
    await until(() => c.of("account.signin").some((e) => e.state === "failed"));
    expect(String(c.of("account.signin").find((e) => e.state === "failed")!.error)).toContain("not finished");
    c.send({ cmd: "account.signin", id: "codex" });
    c.send({ cmd: "account.signin", id: "nobody" });
    await until(() => c.of("account.signin").filter((e) => e.state === "failed").length === 3);
    expect(c.of("account.signin").filter((e) => e.state === "failed").map((e) => e.error).slice(1)).toEqual(["That program is not installed on this computer.", "That program is not known."]);
    expect(c.saved.size).toBe(0);
  });

  test("stopping the wait stops the program too", async () => {
    const c = computer();
    c.state.signInAfter = 1000;
    c.send({ cmd: "account.signin", id: "claude-code" });
    await until(() => c.of("account.signin").length === 1);
    c.send({ cmd: "account.signin.cancel", id: "claude-code" });
    expect(c.of("account.signin").at(-1)!.state).toBe("stopped");
    c.state.ends = true;
    await new Promise((r) => setTimeout(r, 30));
    expect(c.saved.size).toBe(0);
    expect(c.of("accounts")).toHaveLength(0);
  });
});

describe("signing out of a program from the page", () => {
  test("navvied's saved sign-in for it is taken away (the entry), the program itself is left as it is, and the accounts follow", async () => {
    const c = computer({ codex: true });
    c.send({ cmd: "account.signout", id: "codex" });
    await until(() => c.of("accounts").length === 1);
    expect(c.removed).toEqual(["codex"]);
    expect(c.sys.ran.every((a) => !a.includes("logout"))).toBe(true);
    c.send({ cmd: "account.signout", id: "claude-code" });
    await until(() => c.removed.length === 2);
    expect(c.removed).toEqual(["codex", "claude"]);
    c.send({ cmd: "account.signout", id: "nobody" });
    await until(() => c.of("error").length === 1);
    expect(c.of("error")[0]!.msg).toBe("That program is not known.");
  });
});

describe("in Navvied Cloud", () => {
  test("all four are refused and no program is run", () => {
    const c = computer({ cloud: true });
    c.send({ cmd: "account.signin", id: "claude-code" });
    c.send({ cmd: "account.signin.code", id: "claude-code", code: "x" });
    c.send({ cmd: "account.signin.cancel", id: "claude-code" });
    c.send({ cmd: "account.signout", id: "claude-code" });
    expect(c.of("error")).toHaveLength(4);
    expect(c.sys.ran).toEqual([]);
  });
});
