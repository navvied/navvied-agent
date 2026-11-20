import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { resolveTheme, setTheme } from "../src/theme.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBanner } from "../src/banner.ts";
import { makeSuggest, pathMatches } from "../src/complete.ts";
import { expandMentions } from "../src/mentions.ts";
import { Renderer } from "../src/render.ts";
import { fakeIO } from "./helpers.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

/** These tests look at colour codes, which depend on the shared theme: start from the default one. */
beforeAll(() => setTheme(resolveTheme(null, {})));

const dirs: string[] = [];
const project = (files: Record<string, string>): string => {
  const d = mkdtempSync(join(tmpdir(), "navvied-ui-")); dirs.push(d);
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(d, name, ".."), { recursive: true }); writeFileSync(join(d, name), text); }
  return d;
};
afterAll(hook("ui removes what it made", async () => { await removeTrees(dirs);; }), HOOK_MS);

describe("banner", () => {
  const info = { version: "1.2.3", cwd: "/home/ana/shop", home: "/home/ana", mode: "auto", model: { name: "qwen3", where: "running on this computer" }, rules: ["NAVVIED.md"] } as const;

  test("says what this is, what is connected, and what to do", () => {
    const text = renderBanner(info, false, 100);
    expect(text).toContain("⬢⬢  navvied");
    expect(text).toContain("v1.2.3");
    expect(text).toContain("Your coding assistant");
    expect(text).toMatch(/Model\s+qwen3\s+running on this computer/);
    expect(text).toMatch(/Folder\s+~\/shop/);
    expect(text).toMatch(/Mode\s+Auto\s+asks only for what cannot be undone/);
    expect(text).toMatch(/Rules\s+NAVVIED\.md/);
    expect(text).toContain("Try it");
    expect(text).toContain('"add a contact page to the website"');
  });

  test("uses plain words and no dot-separated hint lists", () => {
    expect(renderBanner(info, false, 100)).not.toContain(" · ");
    expect(renderBanner({ version: "1", cwd: "/x", mode: "auto" }, false, 100)).not.toContain(" · ");
  });

  test("without a model it says so in one line, and a picker follows right after when one is coming", () => {
    const text = renderBanner({ version: "1.2.3", cwd: "/x", mode: "auto" }, false, 100);
    expect(text).toContain("No model connected yet");
    expect(text).toContain("A model is the AI that does the thinking");
    expect(text).toContain("Type /connect to pick one");
    expect(text).not.toContain("Handy keys");
    const withPicker = renderBanner({ version: "1.2.3", cwd: "/x", mode: "auto", pickerNext: true }, false, 100);
    expect(withPicker).toContain("Pick one below");
    expect(withPicker).not.toContain("/connect");
  });

  test("the mode line reflects the mode it is given", () => {
    expect(renderBanner({ ...info, mode: "ask" }, false, 100)).toMatch(/Mode\s+Ask first\s+asks before changing files/);
  });

  test("a long folder is shortened from the left and no line outgrows the terminal", () => {
    const text = renderBanner({ ...info, cwd: `/very/long/${"directory/".repeat(30)}project` }, false, 80);
    expect(text).toMatch(/Folder\s+…/);
    for (const line of text.split("\n")) expect([...line].length).toBeLessThanOrEqual(80);
  });

  test("colour only when enabled", () => {
    expect(renderBanner(info, false)).not.toContain("\u001b[");
    expect(renderBanner(info, true)).toContain("\u001b[38;5;141m");
  });
});

describe("completion", () => {
  const dir = project({ "src/main.ts": "x", "src/util.ts": "x", "README.md": "x", ".hidden": "x", "node_modules/pkg/index.js": "x" });
  const suggest = makeSuggest([{ name: "help", desc: "Show this list" }, { name: "mode", args: "<ask|auto|plan>", desc: "Switch mode" }, { name: "model", desc: "Choose a model" }], dir);

  test("slash commands are suggested from the start of the line only, with what they do", () => {
    expect(suggest("/mo", 3)).toEqual({ from: 0, items: [
      { label: "/mode <ask|auto|plan>", hint: "Switch mode", insert: "/mode ", run: false },
      { label: "/model", hint: "Choose a model", insert: "/model", run: true },
    ] });
    expect(suggest("/", 1)?.items.map((i) => i.label)).toEqual(["/help", "/mode <ask|auto|plan>", "/model"]);
    expect(suggest("say /mo", 7)).toBeUndefined();
    expect(suggest("/mode ask", 9)).toBeUndefined();
    expect(suggest("/zzz", 4)).toBeUndefined();
  });
  test("@ suggests paths for the word being typed, anywhere in the line, and says where it starts", () => {
    expect(suggest("look at @sr", 11)).toEqual({ from: 8, items: [{ label: "@src/", insert: "@src/", run: false }] });
    expect(suggest("look at @src/m", 14)?.items).toEqual([{ label: "@src/main.ts", insert: "@src/main.ts ", run: false }]);
    expect(suggest("@R", 2)?.items.map((i) => i.label)).toEqual(["@README.md"]);
    expect(suggest("plain words", 11)).toBeUndefined();
    expect(suggest("look at @sr and more", 11)?.from).toBe(8);
  });
  test("hidden files, .git and node_modules are not offered unless asked for by name", () => {
    expect(pathMatches(dir, "")).toEqual(["README.md", "node_modules/".slice(0, 0) + "src/"].filter(Boolean).sort());
    expect(pathMatches(dir, ".h")).toEqual([".hidden"]);
    expect(pathMatches(dir, "nonexistent/")).toEqual([]);
  });
});

describe("@ mentions", () => {
  const dir = project({ "a.ts": "export const a = 1;\n", "sub/b.md": "# B\n", "bin.dat": "\u0000\u0001" });
  test("the contents of mentioned files are appended; the text is kept", () => {
    const out = expandMentions("explain @a.ts and @sub/b.md please", dir);
    expect(out.startsWith("explain @a.ts and @sub/b.md please")).toBe(true);
    expect(out).toContain("[File a.ts]\nexport const a = 1;");
    expect(out).toContain("[File sub/b.md]\n# B");
  });
  test("a file mentioned twice appears once; trailing punctuation is not part of the name", () => {
    const out = expandMentions("see @a.ts, then @a.ts.", dir);
    expect(out.match(/\[File a\.ts\]/g)).toHaveLength(1);
  });
  test("directories, binaries, missing files, outside paths and e-mail addresses are left alone", () => {
    for (const text of ["look in @sub", "read @bin.dat", "read @missing.ts", "read @../etc/passwd", "mail me@example.com"]) expect(expandMentions(text, dir)).toBe(text);
  });
  test("the total is capped", () => {
    const big = project(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, "x".repeat(19_000)])));
    const out = expandMentions(Array.from({ length: 6 }, (_, i) => `@f${i}.txt`).join(" "), big);
    expect(out.match(/\[File /g)!.length).toBeLessThan(6);
  });
});

describe("status line", () => {
  test("how long the turn took and how full the context is, in plain words", () => {
    const f = fakeIO();
    let now = 10_000;
    const r = new Renderer(f.io, { thinking: false, status: () => ({ model: "qwen3", mode: "plan" }), now: () => now });
    r.handle({ ev: "taken", qid: "q" });
    r.handle({ ev: "usage", ctx: 500, win: 1000, out: 5 });
    now += 3200;
    r.handle({ ev: "done", stop: "end_turn" });
    expect(f.err()).toBe("Done in 3.2 s   Context 50% (500 of 1,000 tokens)\n");
  });
  test("the context turns red near the limit, and a stopped turn says so", () => {
    const f = fakeIO({ color: true });
    const r = new Renderer(f.io, { thinking: false });
    r.handle({ ev: "usage", ctx: 900, win: 1000, out: 1 });
    r.handle({ ev: "done", stop: "end_turn" });
    expect(f.err()).toContain("\u001b[31mContext 90%");
    const g = fakeIO();
    new Renderer(g.io, { thinking: false }).handle({ ev: "done", stop: "cancelled" });
    expect(g.err()).toBe("Stopped\n");
  });
});

describe("the banner of a chat", () => {
  test("it speaks of an assistant and of files it makes, and has no mode", () => {
    const out = renderBanner({ version: "1.0.0", cwd: "/home/a/.local/state/navvied/chat/files", mode: "auto", model: { name: "m", where: "here" }, chat: true }, false, 100);
    expect(out).toContain("Your assistant.");
    expect(out).toContain("Files");
    expect(out).not.toContain("Mode ");
    expect(out).not.toContain("add a contact page");
  });
});

