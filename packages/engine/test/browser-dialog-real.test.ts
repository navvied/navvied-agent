import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, closeBrowser, findChrome } from "../src/index.ts";
import { startGuardProxy } from "../src/tools/browser/guard-proxy.ts";
import { launch } from "../src/tools/browser/launch.ts";
import { data as noteText } from "../../protocol/test/support/ci-annotate.ts";
import { removeTree } from "../../protocol/test/support/cleanup.ts";

const chrome = findChrome();
const FLOW_MS = 150_000;
const MOST_TRAFFIC = 70;
const MOST_NOTE = 3_600;
const MOST_NOTES = 4;
const PAGE = `<!doctype html><title>Order</title><body><button onclick="console.log('the click landed'); document.getElementById('r').textContent = confirm('Place the order?') ? 'Order placed' : 'Order cancelled'; console.log('confirm gave an answer')">Place order</button><p id="r">Nothing ordered yet.</p>`;

function recorded(upstream: string, heard: string[]) {
  const begun = performance.now();
  const note = (line: string): void => { heard.push(`+${Math.round(performance.now() - begun)} ${line}`); };
  const asked = new Map<number, string>();
  const server = Bun.serve<{ browser?: WebSocket; early: string[] }, never>({
    port: 0, hostname: "127.0.0.1",
    fetch: (request, s) => (s.upgrade(request, { data: { early: [] } }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (socket) => {
        const real = new WebSocket(upstream);
        socket.data.browser = real;
        real.onopen = () => { for (const text of socket.data.early.splice(0)) real.send(text); };
        real.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { id?: number; method?: string; sessionId?: string; error?: { message: string }; params?: { args?: { value?: unknown }[]; type?: string } };
          const session = message.sessionId?.slice(0, 4) ?? "-";
          if (message.id !== undefined) note(`< ${asked.get(message.id)} ${message.error ? `error ${message.error.message}` : "ok"}`);
          else note(`< event ${message.method} ${session}${message.method === "Runtime.consoleAPICalled" ? ` ${String(message.params?.args?.[0]?.value)}` : message.method?.startsWith("Page.javascriptDialog") ? ` ${message.params?.type ?? ""}` : ""}`);
          socket.send(String(event.data));
        };
      },
      message: (socket, text) => {
        const message = JSON.parse(String(text)) as { id: number; method: string; sessionId?: string; params?: { type?: string } };
        const what = `${message.method}${message.params?.type ? `:${message.params.type}` : ""}#${message.id} ${message.sessionId?.slice(0, 4) ?? "-"}`;
        asked.set(message.id, what);
        note(`> ${what}`);
        const real = socket.data.browser;
        if (real?.readyState === WebSocket.OPEN) real.send(String(text)); else socket.data.early.push(String(text));
      },
      close: (socket) => { socket.data.browser?.close(); },
    },
  });
  return { endpoint: `ws://127.0.0.1:${server.port}/devtools/browser/recorded`, stop: () => server.stop(true) };
}

const askedOnce = (endpoint: string, method: string): Promise<string> => new Promise((resolve) => {
  const socket = new WebSocket(endpoint);
  socket.onopen = () => socket.send(JSON.stringify({ id: 1, method }));
  socket.onmessage = (event) => { resolve(String(event.data)); socket.close(); };
  socket.onerror = () => resolve("the browser could not be asked");
});

function tell(title: string, report: string): void {
  for (let at = 0, part = 1; at < report.length && part <= MOST_NOTES; at += MOST_NOTE, part++) console.log(`::warning title=${title} ${part}::${noteText(report.slice(at, at + MOST_NOTE))}`);
}

describe.skipIf(!chrome || process.platform === "win32")("a page's own question, with this computer's real browser", () => {
  test.each(["this account's home folder", "an empty home folder as the benchmark gives"])("is seen and answered, with %s", async (which) => {
    const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
    const home = process.env.HOME, endpoint = process.env.NAVVIED_BROWSER_ENDPOINT;
    const emptyHome = mkdtempSync(join(tmpdir(), "navvied-dialog-home-"));
    if (which.startsWith("an empty")) process.env.HOME = emptyHome;
    const proxy = startGuardProxy(() => true, () => undefined);
    const heard: string[] = [], said: string[] = [];
    let real: Awaited<ReturnType<typeof launch>> | undefined, recorder: ReturnType<typeof recorded> | undefined;
    try {
      closeBrowser();
      real = await launch(chrome!, proxy.port);
      recorder = recorded(real.endpoint, heard);
      process.env.NAVVIED_BROWSER_ENDPOINT = recorder.endpoint;
      const context = { cwd: "/", signal: new AbortController().signal, emit() {}, allowPrivateNetwork: true } as never;
      const act = async (a: Record<string, unknown>): Promise<string> => { const answer = await browser.run(a, context); said.push(`${String(a.action)}: ${answer.replace(/\s+/g, " ").slice(0, 220)}`); return answer; };
      const opened = await act({ action: "open", url: `http://127.0.0.1:${site.port}/order` });
      await act({ action: "eval", text: "[document.readyState, document.visibilityState, 'hidden=' + document.hidden, 'focus=' + document.hasFocus()].join(' ')" });
      await act({ action: "click", ref: Number(/\[(\d+)\] button "Place order"/.exec(opened)?.[1]) });
      const answered = await act({ action: "dialog", accept: true });
      if (!answered.includes("Order placed")) {
        const started = spawnSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" }).stdout.split("\n").find((line) => line.includes("--remote-debugging-port=0") && !line.includes("--type=")) ?? "the browser's start line was not found";
        tell(`dialog trace with ${which}`, [await askedOnce(real.endpoint, "Browser.getVersion"), ...said, ...heard.slice(-MOST_TRAFFIC), started].join("\n"));
      }
      expect(answered).toContain("Order placed");
    } finally {
      closeBrowser();
      recorder?.stop();
      real?.stop();
      proxy.close();
      site.stop(true);
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      if (endpoint === undefined) delete process.env.NAVVIED_BROWSER_ENDPOINT; else process.env.NAVVIED_BROWSER_ENDPOINT = endpoint;
      await removeTree(emptyHome);
    }
  }, FLOW_MS);
});
