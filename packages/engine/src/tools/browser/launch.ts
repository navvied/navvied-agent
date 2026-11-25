import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree, usesProcessGroups } from "../../platform.ts";

const CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
  win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
  linux: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"],
};

/** Where a Chromium-based browser is on this computer, or nothing. */
export function findChrome(env: Record<string, string | undefined> = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync, which: (c: string) => string | null = (c) => Bun.which(c)): string | undefined {
  if (env.NAVVIED_CHROME && exists(env.NAVVIED_CHROME)) return env.NAVVIED_CHROME;
  for (const c of CANDIDATES[platform] ?? CANDIDATES.linux!) {
    if (c.includes("/") || c.includes("\\")) { if (exists(c)) return c; } else { const found = which(c); if (found) return found; }
  }
  return undefined;
}

/**
 * Where the browser listens, once it has said so: its file holds the port on one line and the address on the next. The file appears before
 * it is whole, so a file that holds less is not an answer yet.
 */
export function devToolsEndpoint(file: string): { port: string; path: string } | undefined {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  const m = /^(\d+)\r?\n(\/\S+)/.exec(text);
  return m ? { port: m[1]!, path: m[2]! } : undefined;
}

/**
 * What a browser says when the network under it changed at the moment it went to a page (a new browser sees this on its first
 * navigation, and so does a person whose Wi-Fi or VPN switches): the page is asked for once more after a pause, and only once. Other
 * errors, and a second failure, are the answer. The pause comes before the page is waited for, so it is not part of the time the page
 * is given to load.
 */
const RETRIED: Record<string, number> = { "net::ERR_NETWORK_CHANGED": 300, "net::ERR_INTERNET_DISCONNECTED": 1_500 };

export async function openWithRetry(go: () => Promise<string | undefined>, wait: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const first = await go();
  const pause = first === undefined ? undefined : RETRIED[first];
  if (pause === undefined) return first;
  await wait(pause);
  return go();
}

/** `NAVVIED_BROWSER_ARGS`: more flags for the browser, as a JSON list of texts (a proxy, a test); anything else is ignored. */
function extraFlags(): string[] {
  try {
    const list: unknown = JSON.parse(process.env.NAVVIED_BROWSER_ARGS ?? "[]");
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && f.startsWith("--")) : [];
  } catch { return []; }
}

class StoppedAtStart extends Error {}

export interface Launched { endpoint: string; stop(): void }

/**
 * Starts the browser with a profile folder of its own (thrown away when it stops), every connection it makes going through the proxy on
 * `proxyPort`. One that stops while starting is started once more: a crash at launch is rare and does not repeat.
 * The profile is the seam for a copy of the person's own profile: a folder given here would be used and kept instead.
 */
export async function launch(chrome: string, proxyPort: number): Promise<Launched> {
  try { return await start(chrome, proxyPort); } catch (e) { if (!(e instanceof StoppedAtStart)) throw e; return start(chrome, proxyPort); }
}

async function start(chrome: string, proxyPort: number): Promise<Launched> {
  // The long form of the folder: a short 8.3 name (RUNNER~1) in a profile path is one more thing for a browser on Windows to trip over.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "navvied-browser-")));
  const child: ChildProcess = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, `--proxy-server=http://127.0.0.1:${proxyPort}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--no-pings", "--mute-audio", "--hide-scrollbars", "--window-size=1280,900", ...(process.platform === "win32" ? ["--disable-gpu"] : []), ...(process.getuid?.() === 0 || process.env.NAVVIED_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), ...extraFlags(), "about:blank"], { detached: usesProcessGroups(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let said = "", stopped: number | null | undefined, over = false;
  child.stderr?.on("data", (d: Buffer) => { said = (said + d.toString("utf8")).slice(-600); });
  child.on("exit", (code) => { stopped = code; });
  child.on("error", (e) => { said += e.message; stopped = null; });
  const stop = (): void => { if (over) return; over = true; killTree(child); try { rmSync(dir, { recursive: true, force: true }); } catch { /* the folder is removed with the temporary files */ } };
  const portFile = join(dir, "DevToolsActivePort");
  const wait = Number(process.env.NAVVIED_BROWSER_START_MS) || 15_000;
  const until = Date.now() + wait;
  let endpoint: { port: string; path: string } | undefined;
  while (!(endpoint = devToolsEndpoint(portFile))) {
    if (stopped !== undefined) { stop(); throw new StoppedAtStart(`the browser stopped while starting (exit ${stopped})${said.trim() ? `: ${said.trim().split("\n").pop()}` : ""}`); }
    if (Date.now() > until) {
      // What was seen, so that a start that never ends can be told from one that never began.
      const seen = [child.pid === undefined ? "never started" : child.exitCode === null ? "still running" : `exit ${child.exitCode}`, `profile: ${(() => { try { return readdirSync(dir).slice(0, 12).join(", ") || "empty"; } catch { return "gone"; } })()}`, said.trim() ? `said: ${said.trim().split("\n").pop()}` : "said nothing"].join("; ");
      stop();
      throw new Error(`the browser did not start in ${Math.round(wait / 1000)} s (${seen})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.on("exit", stop);
  return { endpoint: `ws://127.0.0.1:${endpoint.port}${endpoint.path}`, stop };
}
