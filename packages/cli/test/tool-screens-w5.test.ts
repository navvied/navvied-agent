import { describe, expect, test } from "bun:test";
import type { EngineEvent, PluginInfo } from "@navvied/protocol";
import { agentsScreen } from "../src/agents-screen.ts";
import { memoryHubRows } from "../src/memory-screen.ts";
import { pluginsScreen } from "../src/plugins-screen.ts";
import { Presenter } from "../src/presenter.ts";
import { Renderer } from "../src/render.ts";
import { browserLine, hookLine } from "../src/step-events.ts";
import { fakeIO } from "./helpers.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

class Hub extends FakeLink {
  constructor(private script: Record<string, EngineEvent[] | ((c: Record<string, unknown>) => EngineEvent | string)>, private flow: Record<string, EngineEvent[]> = {}) { super((c) => { const s = script[c.cmd as string]; return typeof s === "function" ? s(c) : s?.[0]; }); }
  override send(cmd: object): void {
    super.send(cmd);
    for (const e of this.flow[(cmd as { cmd: string }).cmd] ?? []) queueMicrotask(() => this.emit(e));
  }
}

describe("steps beside a step", () => {
  const hook = (over: object) => ({ ev: "hook", event: "PreToolUse", decision: "allowed", hook: "no force push", tool: "Bash", ...over }) as Extract<EngineEvent, { ev: "hook" }>;
  test("a hook that decided is said in the page's words", () => {
    expect(hookLine(hook({}))).toBeUndefined();
    expect(hookLine(hook({ decision: "blocked", reason: "Pushing with force is not allowed here." }))).toEqual({ mark: "bad", title: "Hook stopped Bash", under: "The hook “no force push” said: Pushing with force is not allowed here." });
    expect(hookLine(hook({ event: "PostToolUse", decision: "changed", tool: "Write", reason: "ran the formatter" }))).toEqual({ mark: "ok", title: "Hook after Write", right: "ran the formatter" });
  });
  test("what the browser saw is said once, in the page's words", () => {
    const b = (e: object) => browserLine({ ev: "browser", ...e } as Extract<EngineEvent, { ev: "browser" }>);
    expect(b({ what: "dialog", state: "answered", type: "confirm", accepted: false })).toEqual({ mark: "ok", title: "Answered a dialog", right: "Cancel" });
    expect(b({ what: "download", state: "done", name: "report.pdf", bytes: 86_016, path: "/w/downloads/report.pdf" })).toEqual({ mark: "ok", title: "Saved a download", right: "report.pdf, 84 KB", under: "/w/downloads/report.pdf" });
    expect(b({ what: "ref", state: "expired", why: "page-changed" })!.under).toBe("The page changed. navvied looks again.");
    expect(b({ what: "ref", state: "expired", why: "unknown" })!.under).toBe("That number is not on this page.");
    expect(b({ what: "upload", state: "asked" })).toBeUndefined();
  });
  test("they reach the screen as lines of their own", () => {
    const f = fakeIO({ color: false, interactive: true });
    const io = { ...f.io, live: () => undefined };
    const p = new Presenter(io, new Renderer(io, { thinking: false }), { cwd: () => "/w", thinking: false, width: () => 70, now: () => 0, every: () => () => undefined });
    p.handle({ ev: "user", qid: "q", text: "x" });
    p.handle(hook({ decision: "blocked", reason: "No." }));
    expect(f.err()).toContain("Hook stopped Bash");
    expect(f.err()).toContain("The hook “no force push” said: No.");
  });
});

describe("/memory", () => {
  const pending = (items: object[]): EngineEvent => ({ ev: "memory.pending", count: items.length, items } as EngineEvent);
  const item = { id: "m1", scope: "project", action: "add", text: "Prefers short answers", origin: "self", source: "message", n: 3, at: 1 };
  test("it says whether it learns, how many wait, and keeps or dismisses one", async () => {
    const l = new Hub({ "memory.extract": [{ ev: "memory.extract", mode: "rules" }], "memory.pending": [pending([item])] });
    const t = scripted([0, "Keep"]);
    const rows = await memoryHubRows(t.kit(l));
    expect(rows.map((r) => r.label)).toEqual(["on   Learn from conversations", "Waiting for your OK  1", "Remembered"]);
    expect(rows[1]!.hint).toBe("Keep or dismiss what navvied suggests.");
    await rows[1]!.run();
    expect(l.commands("memory.pending").find((c) => c.action)).toEqual({ cmd: "memory.pending", action: "accept", id: "m1" });
    expect(t.shown[0]!.items[0]).toMatchObject({ label: "Prefers short answers", hint: "From your message, message 3" });
  });
  test("learning is switched off by a press, and nothing is waiting then", async () => {
    const l = new Hub({ "memory.extract": [{ ev: "memory.extract", mode: "rules" }], "memory.pending": [pending([])] });
    const t = scripted([]);
    const rows = await memoryHubRows(t.kit(l));
    await rows[0]!.run();
    expect(l.commands("memory.extract").at(-1)).toEqual({ cmd: "memory.extract", mode: "off" });
    expect(rows[1]!.hint).toBe("Nothing is waiting.");
  });
  test("a computer that keeps no notes this way shows no rows", async () => {
    const t = scripted([]);
    expect(await memoryHubRows(t.kit(new FakeLink(() => "Unknown command.")))).toEqual([]);
  });
});

describe("/plugins", () => {
  const plugin = (over: Partial<PluginInfo>): PluginInfo => ({ id: "p", kind: "skill", name: "tidy", description: "Tidies.", enabled: true, source: "user", ...over });
  const plugins = (items: PluginInfo[]): EngineEvent => ({ ev: "plugins", items });
  test("a skill is switched with one press; a project's plugin asks for trust first", async () => {
    const list = plugins([plugin({}), plugin({ id: "q", kind: "plugin", name: "Release helper", source: "project", trusted: false })]);
    const l = new Hub({ plugins: [list], "plugin.toggle": [list] });
    const t = scripted([0, 1, "Trust this project", undefined]);
    await pluginsScreen(t.kit(l));
    expect(l.commands("plugin.toggle")).toEqual([{ cmd: "plugin.toggle", id: "p", enabled: false }]);
    const card = t.shown.find((s) => s.title === "Trust this project's plugin?")!;
    expect(card.frame.body).toEqual(["This project asks to use the plugin Release helper.", "It can run commands when the project is open."]);
    expect(l.commands("skill.review")).toEqual([{ cmd: "skill.review", id: "trust:plugin:Release helper", accept: true }]);
  });
  test("installing shows what it brings and its fingerprint, and only Install fetches those files", async () => {
    const ask = { ev: "plugin.install", state: "ask", from: "/w/helper", name: "Release helper", hash: "3f2a9c61b07d44e28a15f3c991bc0000aaaa", brings: { skills: [], agents: [], commands: ["a", "b"], hooks: 1, mcp: [] } } as EngineEvent;
    const l = new Hub({ plugins: [plugins([])], "plugin.install": (c) => (c.fingerprint ? ({ ev: "plugin.install", state: "done", from: "/w/helper" } as EngineEvent) : ask) });
    const t = scripted([0, "Install", undefined], ["/w/helper"]);
    await pluginsScreen(t.kit(l));
    const dialog = t.shown.find((s) => s.title === "Install plugin")!;
    expect(dialog.frame.body).toEqual(expect.arrayContaining(["Release helper", "sha256 3f2a9c61 b07d44e2 8a15f3c9 91bc0000"]));
    expect(dialog.frame.body!.join("\n")).toContain("Adds 2 commands and 1 hook.");
    expect(l.commands("plugin.install").map((c) => c.fingerprint)).toEqual([undefined, "3f2a9c61b07d44e28a15f3c991bc0000aaaa"]);
    expect(t.shown.at(-1)!.frame.notice).toContain("Installed.");
  });
  test("a connected program is signed in to from its own screen: the link, waiting, and Connected", async () => {
    const mcp = plugin({ id: "m", kind: "mcp", name: "Example Service" });
    const l = new Hub({ plugins: [plugins([mcp])], "mcp.tools": [{ ev: "mcp.tools", query: "", items: [{ server: "Example Service", name: "a", tool: "a", description: "", signature: "" }], total: 1 }], "mcp.resources": [{ ev: "mcp.resources", items: [] }], "mcp.prompts": [{ ev: "mcp.prompts", items: [] }] },
      { "mcp.signin": [{ ev: "mcp.signin", server: "Example Service", state: "waiting", url: "https://example.com/sign-in?code=ABCD-1234" }] });
    const opened: string[] = [];
    const t = scripted([0, "Sign in", { label: undefined, before: () => l.emit({ ev: "mcp.signin", server: "Example Service", state: "done" }) }, undefined, undefined]);
    (t.io as { system: unknown }).system = { open: (u: string) => opened.push(u), copy: async () => true };
    await pluginsScreen(t.kit(l));
    const wait = t.shown.find((s) => s.title === "Connect Example Service")!;
    expect(wait.frame.body).toEqual(expect.arrayContaining(["Sign in to let navvied use Example Service.", "Waiting for you to finish in your browser."]));
    expect(opened).toEqual(["https://example.com/sign-in?code=ABCD-1234"]);
    expect(t.shown.flatMap((x) => x.frame.notice ?? [])).toEqual(["Connected to Example Service.", "navvied found 1 tool, 0 resources and 0 prompts."]);
  });
  test("a failed sign-in says so and offers to try again", async () => {
    const mcp = plugin({ id: "m", kind: "mcp", name: "Example Service" });
    const l = new Hub({ plugins: [plugins([mcp])] }, { "mcp.signin": [{ ev: "mcp.signin", server: "Example Service", state: "failed", reason: "The page was closed before access was allowed." }] });
    const t = scripted([0, "Sign in", "Cancel", undefined, undefined]);
    await pluginsScreen(t.kit(l));
    const fail = t.shown.find((s) => s.frame.body?.includes("Sign-in did not finish."))!;
    expect(fail.frame.body).toContain("The page was closed before access was allowed.");
    expect(fail.items.map((i) => i.label)).toEqual(["Try again", "Cancel"]);
  });
});

describe("/agents", () => {
  const a2a = (tokens: object[]): EngineEvent => ({ ev: "a2a", peers: [], tokens, syncSeconds: 2 } as EngineEvent);
  test("it lists who may ask, makes a token that is shown once, and asks before it takes access back", async () => {
    let tokens: object[] = [{ name: "Sam", createdAt: 1 }];
    const l = new Hub({ "a2a.list": (() => a2a(tokens)) as never, "a2a.token.add": (c) => { tokens = [...tokens, { name: c.name, createdAt: 2 }]; return { ev: "a2a.token", name: c.name as string, token: "nva-4f9c" } as EngineEvent; }, "a2a.token.revoke": (c) => { tokens = tokens.filter((t) => (t as { name: string }).name !== c.name); return a2a(tokens); } });
    const t = scripted(["Create access token", "Done", 0, "Revoke", undefined], ["Build server"]);
    await agentsScreen(t.kit(l));
    expect(t.shown[0]!.items.map((i) => `${i.label}|${i.hint ?? ""}`)).toEqual(["Sam|Not asked yet", "Create access token|"]);
    const made = t.shown.find((s) => s.title === "New access token" && s.items.length)!;
    expect(made.frame.body).toEqual(["Give this token to the other agent's owner.", "", "nva-4f9c", "", expect.stringContaining("Shown once. Copy it now.")]);
    expect(t.shown.find((s) => s.title === "Revoke access for Sam?")!.frame.body).toEqual(["It can no longer ask this navvied."]);
    expect(l.commands("a2a.token.revoke")).toEqual([{ cmd: "a2a.token.revoke", name: "Sam" }]);
  });
  test("with no agents it says so", async () => {
    const t = scripted([undefined]);
    await agentsScreen(t.kit(new FakeLink(() => a2a([]))));
    expect(t.shown[0]!.frame.body).toEqual(["No other agents."]);
  });
});
