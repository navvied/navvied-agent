import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "../src/store.ts";
import { closeBrowser } from "../src/tools/browser.ts";
import { FakeBrowser, type Site } from "./fake-cdp.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(async () => { await cleanupAll(); });

/** The whole engine, a scripted model and a stand-in browser: a login the person wrote in their message. */
const SECRET = "Zx9!kQ7mPw";
const LOGIN: Site = { title: "Sign in", password: [2], ax: [["textbox", "Email", { node: 1 }], ["textbox", "Password", { node: 2 }], ["button", "Sign in", { node: 3 }]] };
let fake: FakeBrowser;
beforeEach(() => { closeBrowser(); fake = new FakeBrowser(); process.env.NAVVIED_BROWSER_ENDPOINT = fake.endpoint; });
afterEach(() => { closeBrowser(); fake.stop(); delete process.env.NAVVIED_BROWSER_ENDPOINT; });

const toolText = (r: ReturnType<typeof rig>): string => r.provider.requests.flatMap((q) => q.messages).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

describe("a login in the person's message", () => {
  test("is typed on the site they named, and it is in no event and no answer the model reads", async () => {
    fake.site("https://bank.test/login", { ...LOGIN, ax: [...LOGIN.ax, ["StaticText", `Signed in with ${SECRET}`]] });
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "Browser", args: { action: "open", url: "https://bank.test/login" } }] } : n === 1 ? { calls: [{ name: "Browser", args: { action: "type", ref: 2, text: SECRET, submit: true } }] } : { text: "Signed in." }));
    await r.turn(prompt(`Sign in at https://bank.test/login as ann@example.com, the password is ${SECRET}`, { mode: "auto" }), 30_000);
    expect(fake.typed.get(2)).toBe(SECRET);
    expect(JSON.stringify(r.events)).not.toContain(SECRET.replace("!", "\\!"));
    // The only place the value appears is the person's own message (and the model's call, which it wrote itself): not in any step, tool event or tool answer.
    const events = r.events.filter((e) => e.ev === "tool");
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(toolText(r)).not.toContain(SECRET);
    expect(toolText(r)).toContain("[hidden");
  }, 40_000);

  test("is not typed when the page is not the one they named, and the model is told in a plain sentence", async () => {
    fake.site("https://bank.test/login", LOGIN);
    fake.site("https://evil.test/login", LOGIN);
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "Browser", args: { action: "open", url: "https://evil.test/login" } }] } : n === 1 ? { calls: [{ name: "Browser", args: { action: "type", ref: 2, text: SECRET } }] } : { text: "Stopped." }));
    await r.turn(prompt(`Sign in at https://bank.test/login, the password is ${SECRET}`, { mode: "auto" }), 30_000);
    expect(fake.typed.size).toBe(0);
    expect(toolText(r)).toContain("Not typed: this page is https://evil.test");
    expect(JSON.stringify(r.events.filter((e) => e.ev === "tool"))).not.toContain(SECRET);
  }, 40_000);

  test("typed in a step with parallel calls (one waiting its turn), it is in no event of any kind and not in the saved session", async () => {
    fake.site("https://bank.test/login", LOGIN);
    const saved = mkdtempSync(join(tmpdir(), "navvied-session-"));
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "Browser", args: { action: "open", url: "https://bank.test/login" } }] }
      : n === 1 ? { calls: [{ name: "Browser", args: { action: "type", ref: 1, text: "ann@example.com" } }, { name: "Browser", args: { action: "type", ref: 2, nested: { again: [SECRET] } } }, { name: "Browser", args: { action: "type", ref: 2, text: SECRET, submit: true } }] }
      : { text: "Signed in." }), { store: new FileSessionStore(saved) });
    try {
      await r.turn(prompt(`Sign in at https://bank.test/login as ann@example.com, the password is ${SECRET}`, { mode: "auto" }), 30_000);
      expect(fake.typed.get(2)).toBe(SECRET);
      const queued = r.events.filter((e) => e.ev === "tool" && e.queued);
      expect(queued.length).toBe(2);
      // Every event the engine emitted, whatever its kind, and the file the session was saved in.
      expect(JSON.stringify(r.events)).not.toContain(SECRET);
      const files = readdirSync(saved).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(1);
      const file = readFileSync(join(saved, files[0]!), "utf8");
      expect(file).not.toContain(SECRET);
      expect(file).toContain("[hidden:");
      expect(JSON.parse(file).messages.length).toBeGreaterThan(3);
    } finally { r.cleanup(); rmSync(saved, { recursive: true, force: true }); }
  }, 40_000);
});
