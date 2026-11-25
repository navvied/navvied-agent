import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "../src/types.ts";
import { browser, closeBrowser } from "../src/tools/browser.ts";
import { FakeBrowser, type Site } from "./fake-cdp.ts";
import { until } from "./helpers.ts";

/** Clicks by place in a picture, hover, drag, a whole form in one call, and frames: the tool against a stand-in for the browser's DevTools endpoint. */

const HOME = "https://shop.test/";
const SECRET = "Zx9!kQ7mPw";
const home: Site = {
  title: "Shop",
  password: [6],
  ax: [
    ["link", "About", { node: 1, url: "https://shop.test/about" }],
    ["textbox", "Search lamps", { node: 2 }],
    ["combobox", "Color", { node: 3, value: "Red" }, [["option", "Red"], ["option", "Blue"]]],
    ["button", "Go", { node: 4 }],
    ["checkbox", "Terms", { node: 5, checked: false }],
    ["textbox", "Password", { node: 6 }],
  ],
};
const PAY = "https://shop.test/pay";
const pay: Site = {
  title: "Pay",
  ax: [["button", "Back", { node: 1 }], ["Iframe", "", { node: 2 }], ["Iframe", "", { node: 3 }]],
  frames: [
    { owner: 2, id: "F-same", url: "https://shop.test/inner", ax: [["button", "Same button", { node: 7 }]] },
    { owner: 3, id: "F-apart", url: "https://pay.test/card", ax: [["textbox", "Card number", { node: 8 }], ["button", "Pay", { node: 9 }]], apart: true },
  ],
};

let fake: FakeBrowser;
let dir: string;
const shown: Part[] = [];
type Ctx = { vision?: boolean; credentials?: { secrets: string[]; origins: string[] }; priv?: boolean };
const run = (a: Record<string, unknown>, o: Ctx = {}): Promise<string> => browser.run(a, {
  cwd: dir, signal: new AbortController().signal, emit() {}, allowPrivateNetwork: o.priv ?? true, show: (p: Part) => { shown.push(p); },
  ...(o.vision !== undefined ? { vision: o.vision } : {}), ...(o.credentials ? { credentials: () => o.credentials } : {}),
} as never);
const open = (url = HOME, o: Ctx = {}): Promise<string> => run({ action: "open", url }, o);
const mouse = (type: string): { x: number; y: number; buttons?: number }[] => fake.calls("Input.dispatchMouseEvent").filter((c) => c.params.type === type).map((c) => c.params as { x: number; y: number; buttons?: number });

beforeEach(() => {
  closeBrowser();
  fake = new FakeBrowser();
  fake.site(HOME, home);
  fake.site(PAY, pay);
  process.env.NAVVIED_BROWSER_ENDPOINT = fake.endpoint;
  dir = mkdtempSync(join(tmpdir(), "navvied-reach-browser-"));
  shown.length = 0;
});
afterEach(() => { closeBrowser(); fake.stop(); delete process.env.NAVVIED_BROWSER_ENDPOINT; });

describe("a place in a screenshot", () => {
  test("is turned into a place in the window by the size of the picture the model was given", async () => {
    fake.window = { w: 1000, h: 600, ratio: 2, x: 0, y: 0 };
    await open();
    await run({ action: "screenshot" }, { vision: true });
    // The picture is cut to what a model reads without shrinking it: 1568 pixels at most on a side, whatever the screen's density.
    expect(fake.calls("Page.captureScreenshot")[0]!.params.clip).toMatchObject({ width: 1000, height: 600, scale: 0.784 });
    const out = await run({ action: "click", x: 784, y: 470 });
    expect(out).toContain("Page: Shop");
    const at = mouse("mousePressed")[0]!;
    expect(at.x).toBeCloseTo(500, 5);
    expect(at.y).toBeCloseTo((470 * 600) / 941, 5);
  });

  test("takes the place as it is when no picture was given, and says when it is outside the picture", async () => {
    await open();
    await run({ action: "click", x: 30, y: 40 });
    expect(mouse("mousePressed")[0]).toMatchObject({ x: 30, y: 40 });
    await run({ action: "screenshot" }, { vision: true });
    const out = await run({ action: "click", x: 5000, y: 10 });
    expect(out).toBe("Error: 5000, 10 is outside the last screenshot (1280 x 800).");
    expect(mouse("mousePressed")).toHaveLength(1);
  });

  test("numbers written as text are taken as numbers, and a click that names nothing says what to name", async () => {
    await open();
    await run({ action: "click", x: "30", y: "40" }, {});
    expect(await run({ action: "click", x: 30 })).toContain("say what to aim at");
  });

  test("a link under the place is checked as a link by number is: a private address is not followed", async () => {
    fake.answers = (x) => (x.includes("elementFromPoint") ? "http://10.1.2.3/secret" : undefined);
    await open(HOME, { priv: false });
    const out = await run({ action: "click", x: 10, y: 10 }, { priv: false });
    expect(out).toContain("not allowed");
    expect(mouse("mousePressed")).toHaveLength(0);
  });

  test("a screenshot of one control is cut from the page's corner, so a scrolled page gives the control and not what is above it", async () => {
    fake.window = { w: 1280, h: 800, ratio: 1, x: 40, y: 300 };
    await open();
    await run({ action: "screenshot", ref: 4 }, { vision: true });
    expect(fake.calls("Page.captureScreenshot")[0]!.params.clip).toMatchObject({ x: 440, y: 300, width: 50, height: 20 });
  });
});

describe("hover and drag", () => {
  test("hover moves the mouse over a control and presses nothing", async () => {
    await open();
    const out = await run({ action: "hover", ref: 4 });
    expect(out).toContain('button "Go"');
    expect(mouse("mouseMoved").at(-1)).toMatchObject({ x: 425, y: 10 });
    expect(mouse("mousePressed")).toHaveLength(0);
  });

  test("a drag by number presses on one control, moves in steps and lets go on the other", async () => {
    await open();
    await run({ action: "drag", ref: 1, to: 4 });
    expect(mouse("mousePressed")).toEqual([expect.objectContaining({ x: 125, y: 10 })]);
    expect(mouse("mouseReleased")).toEqual([expect.objectContaining({ x: 425, y: 10 })]);
    expect(mouse("mouseMoved").filter((m) => m.buttons === 1)).toHaveLength(4);
    expect(fake.calls("Input.dispatchDragEvent")).toHaveLength(0);
  });

  test("a drag by place needs no numbers, and numbers and places mix", async () => {
    await open();
    await run({ action: "drag", x: 10, y: 20, x2: 30, y2: 40 });
    expect(mouse("mousePressed")[0]).toMatchObject({ x: 10, y: 20 });
    expect(mouse("mouseReleased")[0]).toMatchObject({ x: 30, y: 40 });
    await run({ action: "drag", ref: 1, x2: 30, y2: 40 });
    expect(mouse("mousePressed")[1]).toMatchObject({ x: 125, y: 10 });
    expect(await run({ action: "drag", ref: 1 })).toContain("say what to aim at");
  });

  test("a page that uses the browser's own drag and drop is carried through: enter, over and drop where the drag ends, and drags go back to normal", async () => {
    fake.dragData = { items: [{ mimeType: "text/plain", data: "card" }], dragOperationsMask: 1 };
    await open();
    await run({ action: "drag", ref: 1, to: 4 });
    const events = fake.calls("Input.dispatchDragEvent").map((c) => c.params);
    expect(events.map((e) => e.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(events[2]).toMatchObject({ x: 425, y: 10, data: fake.dragData });
    expect(fake.calls("Input.setInterceptDrags").map((c) => c.params.enabled)).toEqual([true, false]);
  });
});

describe("a whole form in one call", () => {
  test("every control is filled by its number: text typed, a list chosen, a box ticked", async () => {
    fake.kinds.set(3, "list"); fake.kinds.set(5, "check");
    await open();
    const out = await run({ action: "fill", fields: { "2": "desk lamp", "3": "Blue", "5": "yes" } });
    expect(out).toContain("Page: Shop");
    expect(fake.typed.get(2)).toBe("desk lamp");
    expect(fake.typed.get(5)).toBe("yes");
    const chosen = fake.calls("Runtime.callFunctionOn").find((c) => c.params.objectId === "node-3" && String(c.params.functionDeclaration).includes("this.options") && !String(c.params.functionDeclaration).includes("password"));
    expect(chosen!.params.arguments).toEqual([{ value: "Blue" }]);
  });

  test("a list of numbers and texts, or the same as JSON text, is taken as well", async () => {
    await open();
    await run({ action: "fill", fields: [{ ref: 2, text: "a" }, { ref: "4", value: "b" }] });
    expect([fake.typed.get(2), fake.typed.get(4)]).toEqual(["a", "b"]);
    await run({ action: "fill", fields: '{"2": "c"}' });
    expect(fake.typed.get(2)).toBe("c");
    expect(await run({ action: "fill" })).toContain("fill needs fields");
    expect(await run({ action: "fill", fields: { x: "1" } })).toContain("fill needs fields");
  });

  test("a number that is not on the page changes nothing and gives the numbers that are", async () => {
    await open();
    const out = await run({ action: "fill", fields: { "2": "a", "99": "b" } });
    expect(out).toContain("there is no control 99 on this page now");
    expect(out).toContain('[1] link "About"');
    expect(fake.typed.size).toBe(0);
  });

  test("a password goes only to the site the person named, and a refusal leaves every field of the form as it was", async () => {
    const wrong = await run({ action: "open", url: HOME }, { credentials: { secrets: [SECRET], origins: ["https://other.test"] } });
    expect(wrong).toContain("Page: Shop");
    const out = await run({ action: "fill", fields: { "2": "ann", "6": SECRET } }, { credentials: { secrets: [SECRET], origins: ["https://other.test"] } });
    expect(out).not.toContain(SECRET);
    expect(out).toMatch(/not typed|Not typed/i);
    expect(fake.typed.size).toBe(0);
    const ok = await run({ action: "fill", fields: { "2": "ann", "6": SECRET } }, { credentials: { secrets: [SECRET], origins: ["https://shop.test"] } });
    expect(ok).not.toContain(SECRET);
    expect(fake.typed.get(6)).toBe(SECRET);
    expect(fake.typed.get(2)).toBe("ann");
  });

  test("a secret in a field that is not a password field is held to the same rule", async () => {
    await open();
    const out = await run({ action: "fill", fields: { "2": SECRET } }, { credentials: { secrets: [SECRET], origins: ["https://other.test"] } });
    expect(out).toMatch(/not typed/i);
    expect(fake.typed.size).toBe(0);
  });
});

describe("frames", () => {
  test("the page and the frames in it are read as one, numbered in one run", async () => {
    const out = await open(PAY);
    expect(out).toContain([
      '[1] button "Back"',
      "frame: https://shop.test/inner",
      '  [2] button "Same button"',
      "frame: https://pay.test/card",
      '  [3] textbox "Card number"',
      '  [4] button "Pay"',
    ].join("\n"));
  });

  test("a frame of another site is held until it is under the same look, then let go", async () => {
    await open(PAY);
    const session = [...fake.frameSessions.keys()][0]!;
    const sent = fake.seen.filter((s) => s.sessionId === session).map((s) => s.method);
    expect(sent).toContain("Fetch.enable");
    expect(sent.indexOf("Fetch.enable")).toBeLessThan(sent.indexOf("Runtime.runIfWaitingForDebugger"));
    expect(fake.seen.find((s) => s.method === "Target.setAutoAttach" && s.sessionId)!.params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  });

  test("a request a frame makes goes through the same guard, and is answered on the frame's own session", async () => {
    await open(PAY, { priv: false });
    const session = [...fake.frameSessions.keys()][0]!;
    fake.event("Fetch.requestPaused", { requestId: "r1", request: { url: "http://10.1.2.3/steal" } }, session);
    fake.event("Fetch.requestPaused", { requestId: "r2", request: { url: "http://93.184.216.34/pixel" } }, session);
    await until(() => fake.calls("Fetch.failRequest").length > 0 && fake.seen.some((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "r2"));
    expect(fake.calls("Fetch.failRequest").map((c) => [c.params.requestId, c.sessionId])).toEqual([["r1", session]]);
    expect(fake.seen.find((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "r2")!.sessionId).toBe(session);
  });

  test("a click in a frame of another site is counted from the window's corner: where the frame sits plus where the control is in it", async () => {
    await open(PAY);
    await run({ action: "click", ref: 4 });
    // The control is at 925 in its frame; the frame's element starts at 300 in the page.
    expect(mouse("mousePressed")[0]).toMatchObject({ x: 1225, y: 10 });
    const inFrame = fake.calls("DOM.getContentQuads").find((c) => c.params.backendNodeId === 9)!;
    expect(inFrame.sessionId).toBe([...fake.frameSessions.keys()][0]);
  });

  test("a control of a frame is typed into on the frame's session, and the frame's own site is the one a secret is checked against", async () => {
    await open(PAY);
    await run({ action: "type", ref: 3, text: "4242" });
    expect(fake.typed.get(8)).toBe("4242");
    const call = fake.calls("Runtime.callFunctionOn").find((c) => c.params.objectId === "node-8")!;
    expect(call.sessionId).toBe([...fake.frameSessions.keys()][0]);
    const refused = await run({ action: "fill", fields: { "3": SECRET } }, { credentials: { secrets: [SECRET], origins: ["https://shop.test"] } });
    expect(refused).toMatch(/not typed/i);
    expect(fake.typed.get(8)).toBe("4242");
  });

  test("a frame in the same site is read with the page's own commands", async () => {
    await open(PAY);
    await run({ action: "click", ref: 2 });
    expect(mouse("mousePressed")[0]).toMatchObject({ x: 725, y: 10 });
    expect(fake.calls("Accessibility.getFullAXTree").some((c) => c.params.frameId === "F-same")).toBe(true);
  });

  test("a frame that cannot be read is named, and the rest of the page is still given", async () => {
    // The page's tree names the frame element, but the browser knows no frame in it: only the line that says so remains.
    fake.site("https://shop.test/odd", { title: "Odd", ax: [["button", "Alone", { node: 1 }], ["Iframe", "", { node: 2 }]] });
    const out = await open("https://shop.test/odd");
    expect(out).toContain('[1] button "Alone"');
    expect(out).toContain("frame (not readable)");
  });
});
