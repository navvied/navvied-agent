import { statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Tool, ToolContext } from "../types.ts";
import { isPrivateHost } from "./web-fetch.ts";
import { untrusted } from "./untrusted.ts";
import { num, place, str } from "./util.ts";
import { holdsSecret, hideSecrets, originOf, whyNotHere, type Credentials } from "./browser/credentials.ts";
import { describeReading, describeView, shoot } from "./browser/page.ts";
import { shownPath } from "../shown-path.ts";
import { keepPicture } from "./picture-file.ts";
import { Session } from "./browser/session.ts";
import { DialogOpen, KEY_NAMES, RefError, type Point, type Tab } from "./browser/tab.ts";
import { findChrome } from "./browser/launch.ts";
import type { Ref } from "./browser/ax.ts";
import * as nodePath from "node:path";

export function shownFile(project: string, file: string, system: Pick<typeof nodePath, "relative" | "sep"> = nodePath): string {
  return (system.relative(project, file) || file).split(system.sep).join("/");
}

export { findChrome, devToolsEndpoint, openWithRetry } from "./browser/launch.ts";
export { describeReading } from "./browser/page.ts";

/**
 * A browser the agent can use. It drives the Chrome (or Chromium, Edge, Brave) that is already on this computer through its remote-debugging
 * protocol, so nothing is installed. The page is given back as the browser's accessibility tree: what a person sees, with a number on every link
 * and control. The numbers belong to one reading of one page and expire when the page goes elsewhere. The browser runs with a profile of its own
 * that is thrown away, so it has none of the person's logins, history or cookies (a copy of the real profile would be one folder given to
 * `launch` in launch.ts, and nothing else here would change).
 */

let session: Session | undefined;
process.once("exit", () => session?.close());
/** For tests, and for an engine that shuts down: the browser is closed. */
export const closeBrowser = (): void => { session?.close(); session = undefined; };

const refused = (url: URL, allowPrivate: boolean): string | undefined => {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Error: only http(s) addresses can be opened.";
  if (!allowPrivate && isPrivateHost(url.hostname)) return "Error: opening local or private network addresses is not allowed.";
  return undefined;
};

const waits = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CHALLENGE = `(() => { const q = (s) => document.querySelector(s);
  if (q('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, #cf-challenge-running')) return "captcha";
  if (q('input[autocomplete="one-time-code"]')) return "code";
  const t = (document.body ? document.body.innerText : "").slice(0, 4000);
  return /verification code|one-time (code|password)|authenticator app|two-factor|2-step verification|(6|six)-digit/i.test(t) && q("input:not([type=hidden]):not([type=password])") ? "code" : "";
})()`;
const QUESTIONS = {
  code: { question: "The site asks for a one-time code. Type the code, or say stop." },
  captcha: { question: "The site shows a check that only a person can pass, so it cannot go on here. What now?", choices: ["Stop here", "Try another way"] },
};

/** The text of what a tool must hand the model right away: a trusted line of ours, then what the page said inside its frame. */
const said = (note: string, page?: string): string => (page ? `${note}\n\n${page}` : note);

/**
 * The page the model was just given takes the place of the one it was given before of the same tab: a long visit does not fill the window
 * with stale text. What stays of an old page is a short note, with the host only, since the rest of an address is the page's to write.
 */
function supersede(ctx: ToolContext, s: Session, tab: Tab, reading: string): void {
  let host = "";
  try { host = new URL(tab.url).host; } catch { /* no address yet */ }
  ctx.keepOut?.(`[page of tab ${s.tabs.indexOf(tab) + 1}${host ? ` (${host})` : ""} was shown to the model only: ${reading.split("\n").length} lines]`, `browser:${tab.targetId}`);
}

const dialogNote =(d: NonNullable<Tab["dialog"]>): string =>
  said(`A ${d.type} dialog is open on the page, and nothing else works until it is answered: Browser {"action": "dialog", "accept": true or false${d.type === "prompt" ? ', "text": the answer' : ""}}.`, untrusted("browser", `${d.message}${d.defaultPrompt ? `\n(default answer: ${d.defaultPrompt})` : ""}`));

async function pageOrigin(tab: Tab): Promise<string | undefined> {
  const o = originOf(await tab.eval<string>("location.href"));
  return o;
}

/** A challenge on the page that only the person can answer is put to them as a question; it is never solved or guessed here. */
async function challenge(tab: Tab, ctx: ToolContext): Promise<string> {
  const kind = await tab.eval<"" | "code" | "captcha">(CHALLENGE).catch(() => "" as const);
  if (!kind) { tab.asked = ""; return ""; }
  const key = `${tab.url} ${kind}`;
  if (tab.asked === key) return "";
  tab.asked = key;
  const what = kind === "code" ? "a one-time code" : "a check that only a person can pass";
  if (!ctx.ask) return `\nThis page asks for ${what}. Do not guess it or try to get past it: tell the person, and stop here.`;
  const answer = await ctx.ask([QUESTIONS[kind]], ctx.signal);
  return `\nThis page asks for ${what}. The person was asked: ${answer}${kind === "captcha" ? "\nDo not try to solve the check yourself." : ""}`;
}

const ACTIONS = ["open", "read", "click", "hover", "drag", "type", "fill", "choose", "press", "scroll", "back", "screenshot", "dialog", "tabs", "switch", "new", "close", "wait", "upload", "console", "eval"];
const NUMBERS = ["ref", "tab", "offset", "seconds", "x", "y", "to", "x2", "y2"];

/** Controls to fill in as the model writes them: an object of number to text, or a list of {ref, text}, or either as JSON text. */
function fieldList(v: unknown): [number, string][] | undefined {
  let value = v;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  const pairs: [unknown, unknown][] = Array.isArray(value) ? value.map((f) => [f?.ref, f?.text ?? f?.value]) : value && typeof value === "object" ? Object.entries(value) : [];
  const list = pairs.map(([k, t]): [number, string] => [Number(k), typeof t === "string" ? t : t === undefined || t === null ? "" : String(t)]);
  return list.length && list.length <= 30 && list.every(([n]) => Number.isInteger(n)) ? list : undefined;
}

/** What a control of a form is, and where it is, before anything is put in it. */
interface Probe { password: boolean; origin: string; kind: "list" | "check" | "text" }
const PROBE = "function () { return { password: this.type === 'password', origin: location.origin, kind: this.options ? 'list' : this.type === 'checkbox' || this.type === 'radio' ? 'check' : 'text' }; }";
const CHOOSE = `function (want) { if (!this.options) return "not a list"; const o = [...this.options].find((x) => x.text.trim().toLowerCase() === want.toLowerCase() || x.value === want); if (!o) return "none"; this.value = o.value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; }`;
const CHECK = `function (expected, text) { if (location.origin !== expected) return "moved"; const want = !/^(false|no|off|unchecked|0|)$/i.test(text.trim()); if (this.checked !== want) this.click(); return "ok"; }`;
const WRITE = `function (expected, text) {
  if (location.origin !== expected) return "moved";
  this.scrollIntoView({ block: "center" }); this.focus();
  if ("value" in this) { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set; if (set) set.call(this, text); else this.value = text; }
  else if (this.isContentEditable) { document.execCommand("selectAll"); document.execCommand("insertText", false, text); }
  else return "not a field";
  this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return "ok";
}`;
const LINK_AT = `((x, y) => { const a = document.elementFromPoint(x, y)?.closest("a[href]"); return a ? a.href : ""; })`;

/** Whether a browser can be driven here: one is installed, or one is already listening. */
export const browserHere = (): boolean => !!(findChrome() || process.env.NAVVIED_BROWSER_ENDPOINT);

export const browser: Tool = {
  name: "Browser",
  readOnly: false,
  offeredWhen: ({ small }) => !small && browserHere(),
  description: "Use a real web browser. Read the page as numbered text (frames too), then act by number; numbers expire when the page changes. Actions: open (url), read, click/hover (ref, or x y of the last screenshot), drag (ref or x y, to or x2 y2), type (ref, text, submit), fill (fields), choose (ref, text), press (text: key), scroll (direction), back, screenshot, dialog (accept, text), tabs, switch/new/close (tab, url), wait (text, selector, seconds), upload (ref, path), console, eval (text). A login the person gave may be typed on the site they named.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS },
      url: { type: "string" }, ref: { type: "number" }, text: { type: "string" }, fields: { type: "object", description: "ref: text" },
      offset: { type: "number", description: "read from" }, submit: { type: "boolean" }, direction: { type: "string", enum: ["up", "down"] },
      tab: { type: "number" }, accept: { type: "boolean" }, selector: { type: "string" }, seconds: { type: "number" }, path: { type: "string", description: "upload file; download folder" },
      x: { type: "number" }, y: { type: "number" }, to: { type: "number" }, x2: { type: "number" }, y2: { type: "number" },
    },
    required: ["action"],
  },
  // A small model writes numbers as text ("3"): the tool takes them as numbers.
  fixArgs: (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, NUMBERS.includes(k) && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v])),
  title: (a) => (str(a.action) === "open" ? `Open ${str(a.url)}` : `Browser: ${str(a.action)}${a.ref !== undefined ? ` ${a.ref}` : ""}`),

  asks(a, where) {
    if (str(a.action) !== "upload" || !session || session.closed) return undefined;
    const site = originOf(session.current.url);
    if (!site) return undefined;
    try {
      const file = place(where, a.path);
      const st = statSync(file);
      return st.isFile() ? { upload: { path: shownPath(file, where.cwd), bytes: st.size, site } } : undefined;
    } catch { return undefined; }
  },

  async run(a, ctx) {
    const action = str(a.action);
    if (!ACTIONS.includes(action)) return `Error: unknown action "${action}".`;
    if (action === "close" && a.tab === undefined) { closeBrowser(); return "The browser is closed."; }
    const chrome = findChrome();
    if (!chrome && !process.env.NAVVIED_BROWSER_ENDPOINT) return "Error: no browser was found on this computer. Install Chrome, Chromium or Edge, or set NAVVIED_CHROME to its path.";
    const cred: Credentials | undefined = ctx.credentials?.();
    const out = (text: string): string => { const hidden = hideSecrets(text, cred); ctx.outside?.(hidden); return hidden; };

    let url: URL | undefined;
    if (action === "open" || (action === "new" && str(a.url))) {
      try { url = new URL(str(a.url)); } catch { return "Error: that is not a valid address."; }
      const no = refused(url, ctx.allowPrivateNetwork);
      if (no) return no;
    }
    try {
      if (!session || session.closed) session = await Session.open(chrome);
      const s = session;
      s.allowPrivate = ctx.allowPrivateNetwork;
      s.say = (note) => ctx.emit({ ev: "browser", ...note });
      s.touch();
      let tab = s.current;
      const folder = place(ctx, str(a.path) && action !== "upload" ? a.path : join(ctx.cwd, "downloads"));
      const downloadMark = s.downloads.length;

      // A secret the person gave goes to the site they named and nowhere else: not typed, not put in an address, not run in a script.
      if (cred && ["open", "new", "type", "fill", "eval", "wait", "press"].includes(action) && holdsSecret([a.text, a.url, a.selector, ...(fieldList(a.fields) ?? []).map(([, t]) => t)].map((v) => str(v)).join("\n"), cred)) {
        const where = url ? originOf(url.href) : await pageOrigin(tab).catch(() => undefined);
        const why = whyNotHere(where, cred);
        if (why) return why;
      }

      if (action === "tabs") return out(said("Tabs:", untrusted("browser", (await s.list()).map((t) => `${t.n}${t.current ? "*" : " "} ${t.title || "(no title)"} - ${t.url}`).join("\n"))));
      if (action === "switch" || (action === "close" && a.tab !== undefined)) {
        const n = Math.floor(num(a.tab, 0));
        const target = s.tabs[n - 1];
        if (!target) return `Error: there is no tab ${n}. Use tabs to list them.`;
        if (action === "close") { await s.closeTab(target); return `Tab ${n} is closed.`; }
        s.current = tab = target;
        await s.cdp.send("Target.activateTarget", { targetId: target.targetId }).catch(() => undefined);
      }
      if (action === "dialog") {
        const announced = tab.dialog;
        const accepted = a.accept !== false;
        const answered = await tab.answerDialog(accepted, a.text !== undefined ? str(a.text) : undefined);
        if (answered !== "answered") return `There is no dialog open. The browser says: ${answered.refused}`;
        s.say({ what: "dialog", state: "answered", type: announced?.type ?? "unannounced", accepted });
        await tab.settle();
        const reading = await tab.read();
        supersede(ctx, s, tab, reading);
        return out(said(`${announced ? `The ${announced.type} dialog` : "A dialog the browser had not announced"} was ${accepted ? "accepted" : "dismissed"}.`, describeReading(reading, ctx.window)));
      }
      if (tab.dialog && !["console", "switch", "new"].includes(action)) return out(dialogNote(tab.dialog));

      await s.downloadsTo(folder);
      let note = "";
      const numbered = (): Promise<Ref> => tab.ref(Math.floor(num(a.ref, 0)));
      // What an action is aimed at: a control by its number, or a place in the last picture of the window.
      const target = async (ref: unknown, x: unknown, y: unknown): Promise<{ ref: Ref } | { point: Point } | string> => {
        if (ref !== undefined) return { ref: await tab.ref(Math.floor(num(ref, 0))) };
        if (typeof x !== "number" || typeof y !== "number") return "Error: say what to aim at: ref, the number of a control, or x and y, a place in the last screenshot.";
        const point = tab.fromShot(x, y);
        return point ? { point } : `Error: ${x}, ${y} is outside the last screenshot${tab.shot ? ` (${tab.shot.width} x ${tab.shot.height})` : ""}.`;
      };
      const spot = (t: { ref: Ref } | { point: Point }): Promise<Point | undefined> => ("ref" in t ? tab.point(t.ref) : Promise.resolve(t.point));
      // A password field takes text only on a site the person named, whatever the text is.
      const barred = (probe: Probe, text: string): string | undefined => (probe.password || holdsSecret(text, cred) ? whyNotHere(originOf(probe.origin), cred) : undefined);
      const put = (ref: Ref, probe: Probe, text: string): Promise<string | undefined> =>
        tab.onElement<string>(ref, probe.kind === "list" ? CHOOSE : probe.kind === "check" ? CHECK : WRITE, probe.kind === "list" ? [text] : [probe.origin, text]).then((r) => (r === "ok" ? undefined : r));
      const problem = (n: number, what: string, text: string): string => (what === "none" ? `Error: control ${n} has no choice "${text}".` : `Error: control ${n} cannot be typed into.`);
      if (action === "new") { tab = await s.newTab(url?.href); }
      else if (action === "open") { await tab.navigate(url!.href); }
      else if (action === "back") { if (!(await tab.back())) return "Error: there is no earlier page."; }
      else if (action === "scroll") { await tab.eval(`window.scrollBy(0, ${a.direction === "up" ? "-" : ""}Math.round(innerHeight * 0.85))`); await waits(300); }
      else if (action === "click" || action === "hover") {
        const at = await target(a.ref, a.x, a.y);
        if (typeof at === "string") return at;
        // A link to somewhere that must not be reached is not followed; the browser would be stopped at the request, but the model is told why now.
        const href = "ref" in at ? at.ref.href ?? "" : await tab.eval<string>(`${LINK_AT}(${at.point.x}, ${at.point.y})`).catch(() => "");
        if (href && action === "click") { try { const no = refused(new URL(href), ctx.allowPrivateNetwork); if (no) return no; } catch { /* not an address */ } }
        if ("ref" in at && action === "click") await tab.click(at.ref);
        else {
          const p = await spot(at);
          if (!p) return `Error: control ${num(a.ref, 0)} is not on screen, so there is no place to ${action}.`;
          await (action === "click" ? tab.clickAt(p) : tab.hoverAt(p));
        }
        await tab.settle();
      } else if (action === "drag") {
        const from = await target(a.ref, a.x, a.y);
        if (typeof from === "string") return from;
        const to = await target(a.to, a.x2, a.y2);
        if (typeof to === "string") return to;
        const [start, end] = [await spot(from), await spot(to)];
        if (!start || !end) return "Error: the control to drag, or the one to drop it on, is not on screen.";
        await tab.dragBetween(start, end);
        await tab.settle();
      } else if (action === "type") {
        const ref = await numbered();
        const probe = await tab.onElement<Probe>(ref, PROBE);
        const why = barred(probe, str(a.text));
        if (why) return why;
        const done = await put(ref, probe, str(a.text));
        if (done) return done === "moved" ? "Not typed: the page moved to another site while this was being typed." : problem(num(a.ref, 0), done, str(a.text));
        if (a.submit === true) await tab.press("Enter");
        await tab.settle();
      } else if (action === "fill") {
        const list = fieldList(a.fields);
        if (!list) return 'Error: fill needs fields, the number of each control and what goes in it: {"3": "ann", "4": "yes"}.';
        // Every control is looked at before one is changed, so a refusal leaves the form as it was.
        const planned: { ref: Ref; probe: Probe; text: string; n: number }[] = [];
        for (const [n, text] of list) {
          const ref = await tab.ref(n);
          const probe = await tab.onElement<Probe>(ref, PROBE);
          const why = barred(probe, text);
          if (why) return why;
          planned.push({ ref, probe, text, n });
        }
        for (const [i, f] of planned.entries()) {
          const done = await put(f.ref, f.probe, f.text);
          if (done) return `${done === "moved" ? "Not typed: the page moved to another site while this was being typed." : problem(f.n, done, f.text)}${i ? ` The ${i} before it ${i === 1 ? "was" : "were"} filled.` : ""}`;
        }
        await tab.settle();
      } else if (action === "choose") {
        const ref = await numbered();
        const done = await tab.onElement<string>(ref, CHOOSE, [str(a.text)]);
        if (done === "not a list") return `Error: control ${num(a.ref, 0)} is not a list to choose from; click it, then click the choice.`;
        if (done === "none") return `Error: control ${num(a.ref, 0)} has no choice "${str(a.text)}".`;
        await tab.settle();
      } else if (action === "press") {
        if (a.ref !== undefined) await tab.onElement(await numbered(), "function () { this.focus(); }");
        if (!(await tab.press(str(a.text)))) return `Error: press needs a key in text: ${KEY_NAMES.join(", ")}.`;
        await tab.settle();
      } else if (action === "wait") {
        const seconds = Math.min(30, Math.max(1, num(a.seconds, 10)));
        const until = Date.now() + seconds * 1000;
        const text = str(a.text), selector = str(a.selector);
        let met = false;
        if (text || selector) {
          while (!met && Date.now() < until && !ctx.signal.aborted) {
            met = await tab.eval<boolean>(`(() => { ${text ? `if (!(document.body ? document.body.innerText : "").toLowerCase().includes(${JSON.stringify(text.toLowerCase())})) return false;` : ""} ${selector ? `try { if (!document.querySelector(${JSON.stringify(selector)})) return false; } catch { return false; }` : ""} return true; })()`);
            if (!met) await waits(100);
          }
        } else met = await tab.idle(500, seconds * 1000);
        note = met ? "" : `Waited ${seconds} s and it did not happen${text || selector ? ` (${[text && `text "${text}"`, selector && `selector ${selector}`].filter(Boolean).join(", ")})` : ": the page was still loading"}. This is the page now.`;
        await tab.settle().catch(() => undefined);
      } else if (action === "upload") {
        const file = place(ctx, a.path);
        let size = -1;
        try { const st = statSync(file); size = st.isFile() ? st.size : -1; } catch { /* not there */ }
        if (size < 0) return `Error: ${file} is not a file to upload.`;
        const field = a.ref !== undefined ? await numbered() : undefined;
        const node = field ? field.node : tab.chooser;
        if (node === undefined) return "Error: say which field with ref (a file field), or click the button that opens the file chooser first.";
        await tab.send("DOM.setFileInputFiles", { files: [file], backendNodeId: node }, field?.place?.session);
        tab.chooser = undefined;
        note = `Uploaded ${relative(ctx.cwd, file) || file} (${size} bytes).`;
        s.say({ what: "upload", state: "done", name: basename(file), bytes: size });
        await tab.settle();
      } else if (action === "screenshot") {
        const box = a.ref !== undefined ? await tab.box(await numbered()) : undefined;
        // A picture goes only to a model that can see; any other gets the page in words.
        if (ctx.vision === true && ctx.show) {
          const shot = await shoot(tab, box);
          ctx.show({ type: "image", mime: "image/jpeg", data: shot.data });
          keepPicture(ctx, "browser", Buffer.from(shot.data, "base64"), "image/jpeg", "jpg");
          return `Screenshot of ${tab.url} (${shot.bytes} bytes), shown to you in the next message.`;
        }
        return out(said("This model cannot see pictures, so this is the page in words.", await describeView(tab)));
      } else if (action === "console") {
        const lines = [...(tab.console.length ? [`Console (${tab.console.length}):`, ...tab.console.slice(-20)] : ["Console: nothing was written."]), ...(tab.failures.length ? [`Failed requests (${tab.failures.length}):`, ...tab.failures.slice(-20)] : ["Failed requests: none."])];
        return out(untrusted("browser", lines.join("\n")));
      } else if (action === "eval") {
        const value = await tab.eval<unknown>(str(a.text));
        return out(said("Result:", untrusted("browser", typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"))));
      } else if (action !== "read" && action !== "switch") return `Error: unknown action "${action}".`;

      const tail: string[] = [];
      if (s.opened.length) { tail.push(`A new tab opened (tab ${s.tabs.indexOf(s.current) + 1}) and is the current one.`); tab = s.current; s.opened = []; }
      const reading = action === "read" && num(a.offset, 0) > 0 && tab.reading ? tab.reading : await tab.read();
      const got = await s.downloaded(downloadMark, 30_000);
      for (const d of got) tail.push(d.state === "done" ? `Downloaded ${shownFile(ctx.cwd, d.path!)} (${d.bytes} bytes).` : d.state === "going" ? `Still downloading ${d.name}.` : `The download of ${d.name} failed${d.note ? `: ${d.note}` : ""}.`);
      if (tab.chooser !== undefined) tail.push("A file chooser is open: use upload with path.");
      const asked = ["open", "click", "type", "press", "new", "wait"].includes(action) ? await challenge(tab, ctx) : "";
      const head = [note, ...tail].filter(Boolean).join("\n");
      if (!(action === "read" && num(a.offset, 0) > 0)) supersede(ctx, s, tab, reading);
      return out(`${head ? `${head}\n\n` : ""}${describeReading(reading, ctx.window, action === "read" ? Math.max(0, Math.floor(num(a.offset, 0))) : 0)}${asked}`);
    } catch (e) {
      if (e instanceof DialogOpen) return out(dialogNote(e.dialog));
      if (e instanceof RefError) {
        session?.say?.({ what: "ref", state: "expired", why: e.why, ...(a.ref !== undefined ? { ref: Math.floor(num(a.ref, 0)) } : {}) });
        // The numbers are given again with the answer, so the next call can use them.
        const live = session && !session.closed ? session : undefined;
        const fresh = live ? await live.current.read().then((r) => { supersede(ctx, live, live.current, r); return describeReading(r, ctx.window); }).catch(() => "") : "";
        return out(said(`Error: ${e.message}${fresh ? " These are the numbers now." : ""}`, fresh || undefined));
      }
      const dead = session?.closed;
      if (dead) session = undefined;
      return out(`Error: ${e instanceof Error ? e.message : String(e)}${dead ? " (the browser was closed; open the page again)" : ""}`);
    }
  },
};
