import { afterAll, describe, expect, test } from "bun:test";
import type { Cdp } from "../src/tools/browser/cdp.ts";
import { Session } from "../src/tools/browser/session.ts";
import { Tab } from "../src/tools/browser/tab.ts";

const REFUSAL = "not allowed here";
const browsers: { stop(closeNow: boolean): void }[] = [];
const before = process.env.NAVVIED_BROWSER_ENDPOINT;
afterAll(() => {
  for (const browser of browsers) browser.stop(true);
  if (before === undefined) delete process.env.NAVVIED_BROWSER_ENDPOINT; else process.env.NAVVIED_BROWSER_ENDPOINT = before;
});

function aBrowserThatRefuses(method: string): string {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request, s) => (s.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message: (socket, text) => {
        const asked = JSON.parse(String(text)) as { id: number; method: string; sessionId?: string };
        const say = (message: object): void => { socket.send(JSON.stringify(message)); };
        if (asked.method === method) return say({ id: asked.id, error: { message: REFUSAL } });
        if (asked.method === "Target.createTarget") say({ method: "Target.attachedToTarget", params: { sessionId: "page-session", targetInfo: { type: "page", targetId: "page" } } });
        say({ id: asked.id, result: asked.method === "Target.createTarget" ? { targetId: "page" } : asked.method === "Target.getTargets" ? { targetInfos: [] } : {} });
      },
    },
  });
  browsers.push(server);
  return `ws://127.0.0.1:${server.port}/devtools/browser/one`;
}

describe("a page the browser does not let be set up", () => {
  test.each(["Page.enable", "Runtime.enable", "Fetch.enable"])("is an error that names %s and the browser's reason, and nothing waits for the page", async (method) => {
    process.env.NAVVIED_BROWSER_ENDPOINT = aBrowserThatRefuses(method);
    await expect(Session.open(undefined)).rejects.toThrow(`the page could not be set up (${method}): ${REFUSAL}`);
  });
});

describe("a call to a page that is never answered", () => {
  const silent = { send: async (method: string) => { if (method === "Runtime.evaluate") throw new Error("Runtime.evaluate took too long"); return {}; } } as unknown as Cdp;

  test("says how many dialogs the browser had announced for the page", async () => {
    const tab = new Tab(silent, "target", "session", async () => undefined, () => undefined);
    await tab.init();
    await expect(tab.eval("1")).rejects.toThrow("Runtime.evaluate took too long (dialogs the browser announced for this page: 0)");
    tab.handle("Page.javascriptDialogOpening", { type: "confirm", message: "sure?" });
    tab.handle("Page.javascriptDialogClosed", {});
    await expect(tab.eval("1")).rejects.toThrow("(dialogs the browser announced for this page: 1)");
  });
});
