import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeBrowser } from "../src/tools/browser.ts";
import type { Message } from "../src/types.ts";
import { FakeBrowser, type Site } from "./fake-cdp.ts";
import { FakeComputer, type FakeWorld } from "./computer-fake.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

/** A long visit does not fill the window: the page of a tab takes the place of the one before it, as a capture of the screen does. */

const page = (title: string, line: string): Site => ({ title, ax: [["heading", line, { level: 1 }], ["link", "Next", { node: 1, url: "https://shop.test/b" }]] });
const WORLD: FakeWorld = { Notes: { start: "editor", screens: { editor: { tree: ['1 window "Untitled"', '2 text field "Body"'] } } } };

let fake: FakeBrowser;
beforeEach(() => {
  closeBrowser();
  fake = new FakeBrowser();
  fake.site("https://shop.test/a", page("A", "First page text"));
  fake.site("https://shop.test/b", page("B", "Second page text"));
  fake.site("https://shop.test/c", page("C", "Third page text"));
  process.env.NAVVIED_BROWSER_ENDPOINT = fake.endpoint;
});
afterEach(() => { closeBrowser(); fake.stop(); delete process.env.NAVVIED_BROWSER_ENDPOINT; });

type Call = { name: string; args: unknown };
const script = (...steps: Call[]) => (_req: unknown, n: number) => (n < steps.length ? { calls: [steps[n]!] } : { text: "done" });
const go = (action: string, more: Record<string, unknown> = {}): Call => ({ name: "Browser", args: { action, ...more } });
const asText = (m: Message): string => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : `<${p.type}>`)).join(" "));
const tools = (r: ReturnType<typeof rig>): string[] => r.provider.requests.at(-1)!.messages.filter((m) => m.role === "tool").map(asText);
const saved = (): { store: { save(id: string, m: Message[]): void; load(id: string): Message[] | null }; last: () => Message[] } => {
  let last: Message[] = [];
  return { store: { save: (_id, m) => { last = structuredClone(m); }, load: () => null }, last: () => last };
};
const NOTE = /^\[page of tab \d \(shop\.test\) was shown to the model only: \d+ lines\]$/;

describe("old pages of the browser", () => {
  test("the page of a tab is replaced by a short note when a newer one of the same tab is read, and the newest is whole", async () => {
    const r = rig(script(go("open", { url: "https://shop.test/a" }), go("open", { url: "https://shop.test/b" }), go("open", { url: "https://shop.test/c" })));
    await r.turn(prompt("Use the browser to look at the shop"));
    const seen = tools(r);
    expect(seen[0]).toMatch(NOTE);
    expect(seen[1]).toMatch(NOTE);
    expect(seen[2]).toContain("Third page text");
    expect(seen.join("\n")).not.toContain("First page text");
    expect(seen.join("\n")).not.toContain("Second page text");
    r.cleanup();
  });

  test("a page is kept out of the saved conversation, the card and what a hook is told: the note stands in", async () => {
    const mem = saved();
    const told: string[] = [];
    const hooks = { pre: async () => ({ notes: [] }), stop: async () => ({ notes: [] }), post: async (i: { output?: string }) => { told.push(String(i.output)); return { notes: [] }; } };
    const r = rig(script(go("open", { url: "https://shop.test/a" })), { store: mem.store, hooks: hooks as never });
    await r.turn(prompt("Use the browser to look at the shop"));
    expect(JSON.stringify(mem.last())).not.toContain("First page text");
    expect(JSON.stringify(r.events)).not.toContain("First page text");
    expect(told[0]).toMatch(NOTE);
    expect(JSON.stringify(r.provider.requests[1]!.messages)).toContain("First page text");
    r.cleanup();
  });

  test("a page of another tab stays, since it is not stale", async () => {
    const r = rig(script(go("open", { url: "https://shop.test/a" }), go("new", { url: "https://shop.test/b" }), go("open", { url: "https://shop.test/c" })));
    await r.turn(prompt("Use the browser to look at the shop"));
    const seen = tools(r);
    expect(seen[0]).toContain("First page text");
    expect(seen[1]).toContain("tab 2");
    expect(seen[1]).toMatch(NOTE);
    expect(seen[2]).toContain("Third page text");
    r.cleanup();
  });

  test("a part of a long page, read with an offset, does not replace the page it belongs to", async () => {
    const r = rig(script(go("open", { url: "https://shop.test/a" }), go("read", { offset: 10 })));
    await r.turn(prompt("Use the browser to look at the shop"));
    expect(tools(r)[0]).toContain("First page text");
    r.cleanup();
  });

  test("a capture of the screen and a page are two kinds: one does not take the place of the other", async () => {
    const r = rig(script(go("open", { url: "https://shop.test/a" }), { name: "computer", args: { action: "capture", app: "Notes" } }, go("open", { url: "https://shop.test/b" })), { computer: new FakeComputer(WORLD) });
    await r.turn(prompt("Use the browser to look at the shop"));
    const seen = tools(r);
    expect(seen[0]).toMatch(NOTE);
    expect(seen[1]).toContain("Body");
    expect(seen[2]).toContain("Second page text");
    r.cleanup();
  });
});
