import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { browser, closeBrowser } from "../src/tools/browser.ts";
import { FakeBrowser, type Site } from "./fake-cdp.ts";

/** What the Browser tool saw happen is told as events of its own; the text the model reads stays what it was (browser-fake.test.ts holds that). */

const HOME = "https://shop.test/";
const home: Site = {
  title: "Shop",
  text: "Welcome",
  ax: [["link", "About", { node: 1, url: "https://shop.test/about" }], ["textbox", "Search", { node: 2 }], ["button", "Go", { node: 4 }]],
};
const about: Site = { title: "About", text: "About us", ax: [["heading", "About us", { level: 1 }]] };

let fake: FakeBrowser;
let dir: string;
let events: EngineEvent[];
const run = (a: Record<string, unknown>): Promise<string> =>
  browser.run(a, { cwd: dir, signal: new AbortController().signal, emit: (e: EngineEvent) => { events.push(e); }, allowPrivateNetwork: true, report() {} } as never);
const browserEvents = (): EngineEvent[] => events.filter((e) => e.ev === "browser");

beforeEach(() => {
  closeBrowser();
  fake = new FakeBrowser();
  fake.site(HOME, home);
  fake.site("https://shop.test/about", about);
  process.env.NAVVIED_BROWSER_ENDPOINT = fake.endpoint;
  dir = mkdtempSync(join(tmpdir(), "navvied-browser-events-"));
  events = [];
});
afterEach(() => { closeBrowser(); fake.stop(); delete process.env.NAVVIED_BROWSER_ENDPOINT; });

describe("a dialog", () => {
  test("is told when it opens and when it is answered, with its kind and words, and the answer says which way it went", async () => {
    await run({ action: "open", url: HOME });
    fake.onClick.set(4, (p, f) => f.openDialog(p, "confirm", "Delete it?", ""));
    await run({ action: "click", ref: 3 });
    await run({ action: "dialog", accept: false });
    expect(browserEvents()).toEqual([
      { ev: "browser", what: "dialog", state: "opened", type: "confirm", message: "Delete it?" },
      { ev: "browser", what: "dialog", state: "answered", type: "confirm", accepted: false },
    ]);
  });
  test("a prompt carries its default answer", async () => {
    await run({ action: "open", url: HOME });
    fake.onClick.set(4, (p, f) => f.openDialog(p, "prompt", "Your name?", "Ann"));
    await run({ action: "click", ref: 3 });
    expect(browserEvents()[0]).toEqual({ ev: "browser", what: "dialog", state: "opened", type: "prompt", message: "Your name?", defaultPrompt: "Ann" });
  });
});

describe("a download", () => {
  test("is told when it starts and when it is finished, with its name, size and where it is", async () => {
    await run({ action: "open", url: HOME });
    fake.onClick.set(4, () => fake.download("g1", "report.csv", "a,b"));
    await run({ action: "click", ref: 3 });
    const got = browserEvents();
    expect(got[0]).toEqual({ ev: "browser", what: "download", state: "started", name: "report.csv" });
    expect(got[1]).toEqual({ ev: "browser", what: "download", state: "done", name: "report.csv", bytes: 3, path: join(dir, "downloads", "report.csv") });
    expect(got).toHaveLength(2);
  });
});

describe("a file the page asks for", () => {
  test("is told when the chooser opens and when the file went in, by its name only", async () => {
    await run({ action: "open", url: HOME });
    writeFileSync(join(dir, "cv.txt"), "hello");
    fake.event("Page.fileChooserOpened", { backendNodeId: 7, mode: "selectSingle" }, fake.page().sessionId);
    await new Promise((r) => setTimeout(r, 100));
    await run({ action: "upload", path: "cv.txt" });
    expect(browserEvents()).toEqual([
      { ev: "browser", what: "upload", state: "asked" },
      { ev: "browser", what: "upload", state: "done", name: "cv.txt", bytes: 5 },
    ]);
  });
});

describe("a number that no longer stands for anything", () => {
  test("is told as data with why: the page moved, so there was nothing to number there", async () => {
    await run({ action: "open", url: HOME });
    fake.goto(fake.page(), "https://shop.test/about");
    await run({ action: "click", ref: 1 });
    expect(browserEvents().at(-1)).toEqual({ ev: "browser", what: "ref", state: "expired", why: "page-changed", ref: 1 });
    // The page it moved to has nothing to number.
    await run({ action: "click", ref: 1 });
    expect(browserEvents().at(-1)).toEqual({ ev: "browser", what: "ref", state: "expired", why: "unnumbered", ref: 1 });
  });
  test("a number that was never given is `unknown`", async () => {
    await run({ action: "open", url: HOME });
    await run({ action: "click", ref: 9 });
    expect(browserEvents()).toEqual([{ ev: "browser", what: "ref", state: "expired", why: "unknown", ref: 9 }]);
  });
  test("a control that left the page is `gone`", async () => {
    await run({ action: "open", url: HOME });
    fake.page().gone.add(1);
    await run({ action: "click", ref: 1 });
    expect(browserEvents()).toEqual([{ ev: "browser", what: "ref", state: "expired", why: "gone", ref: 1 }]);
  });
});
