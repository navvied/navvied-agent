import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeBrowser } from "../src/tools/browser.ts";
import { shownPath } from "../src/shown-path.ts";
import { FakeBrowser } from "./fake-cdp.ts";
import { HOOK_MS, cleanupAll, prompt, rig, wait } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

/** The question to allow a Browser upload says what goes where as data (`upload`), and the words the model reads are unchanged. */

let fake: FakeBrowser;
beforeEach(() => {
  closeBrowser();
  fake = new FakeBrowser();
  fake.site("https://up.test/form?token=abc", { title: "Up", ax: [["button", "Choose file", { node: 1 }]] });
  process.env.NAVVIED_BROWSER_ENDPOINT = fake.endpoint;
});
afterEach(() => { closeBrowser(); fake.stop(); delete process.env.NAVVIED_BROWSER_ENDPOINT; });

const steps = (...calls: Record<string, unknown>[]) => (_r: unknown, n: number) => (n < calls.length ? { calls: [{ name: "Browser", args: calls[n]! }] } : { text: "done" });
const OPEN = { action: "open", url: "https://up.test/form?token=abc" };

/** Answers every question of the turn with `optionId` and returns them all. */
async function answerAll(r: ReturnType<typeof rig>, turn: Promise<unknown>, optionId: string) {
  let done = false;
  void turn.then(() => { done = true; });
  let answered = 0;
  while (!done) {
    if (r.of("approval").length > answered) { r.send({ cmd: "approve", id: r.of("approval")[answered]!.id, optionId }); answered++; }
    await wait(10);
  }
  return r.of("approval");
}

describe("the question to upload a file", () => {
  test("carries the file as the person reads it, its size in bytes and the site (no path of the page), and the title stays the tool's", async () => {
    const r = rig(steps(OPEN, { action: "upload", ref: 1, path: "docs/cv.txt" }));
    mkdirSync(join(r.dir, "docs"));
    writeFileSync(join(r.dir, "docs", "cv.txt"), "my cv");
    const cards = await answerAll(r, r.turn(prompt("upload my cv", { mode: "ask" })), "allow");
    expect(cards[0]!.upload).toBeUndefined();
    expect(cards[1]!.upload).toEqual({ path: "docs/cv.txt", bytes: 5, site: "https://up.test" });
    expect(cards[1]!.title).toBe("Browser: upload 1");
    r.cleanup();
  });

  test("a secret in the path is hidden", async () => {
    const name = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.txt";
    const r = rig(steps(OPEN, { action: "upload", ref: 1, path: name }));
    writeFileSync(join(r.dir, name), "x");
    const cards = await answerAll(r, r.turn(prompt("upload", { mode: "ask" })), "deny");
    expect(cards.length).toBeGreaterThan(0);
    expect(JSON.stringify(cards)).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    r.cleanup();
  });
});

describe("a path as the person reads it", () => {
  test("is relative inside the project, home-relative inside home, and full elsewhere", () => {
    expect(shownPath("/work/p/a/b.txt", "/work/p", "/home/x")).toBe("a/b.txt");
    expect(shownPath("/home/x/Documents/b.txt", "/work/p", "/home/x")).toBe("~/Documents/b.txt");
    expect(shownPath("/etc/b.txt", "/work/p", "/home/x")).toBe("/etc/b.txt");
    expect(shownPath("/work/p", "/work/p", "/home/x")).toBe("/work/p");
    expect(shownPath(join(homedir(), "z.txt"), "/work/p")).toBe("~/z.txt");
  });
});
