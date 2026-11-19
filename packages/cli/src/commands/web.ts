/**
 * `navvied web`: start the engine on this computer and open the web page already connected to it.
 * The address and key travel after the `#` of the page's address, which no server ever receives; the page reads them and removes them.
 * A page that finds this engine by itself instead has to be allowed here, in the terminal, with a code both sides can see.
 */
import type { Options } from "../args.ts";
import { paint } from "../render.ts";
import type { IO } from "../io.ts";
import type { Decision } from "../pairing.ts";
import { EXIT } from "./run.ts";
import type { DeviceStore } from "../devices.ts";
import type { Hub } from "./hub.ts";
import { parseOrigin, startHttpServer, type HttpServer } from "./serve-http.ts";

export const DEFAULT_SITE = "https://navvied.com";
/** The pages look for an engine on these ports, in this order. */
const PORTS = [8787, 8788, 8789, 8790];

/** The question a person answers when a website asks to use this engine. */
export async function askToPair(io: IO, question: { origin: string; code: string }): Promise<Decision> {
  if (!io.choose) return "no";
  const answer = await io.choose(
    "Allow this website?",
    [
      { label: "Yes, this time", hint: "It can use navvied on this computer until you close navvied." },
      { label: "Yes, and remember this website", hint: "It connects by itself next time. You can remove it with navvied devices." },
      { label: "No" },
    ],
    0,
    {
      heading: [paint(io.color, "cyan", paint(io.color, "bold", "A website wants to use navvied on this computer")), question.origin],
      notice: [`Check that the code is the same in the browser: ${paint(io.color, "bold", question.code)}`, "If you did not just open this website, choose No."],
    },
  );
  return answer === 0 ? "once" : answer === 1 ? "always" : "no";
}

export function connectLink(site: string, address: string, token: string): string {
  return `${site.replace(/\/+$/, "")}/#connect=${encodeURIComponent(address)}&key=${token}`;
}

export interface OpenedWeb { server: HttpServer; link: string; site: string }

/** Starts the server on the first free port and opens the page already connected. */
export async function openWeb(options: Options, io: IO, hub?: Hub, store?: DeviceStore): Promise<{ ok: true; opened: OpenedWeb } | { ok: false; error: string }> {
  const site = parseOrigin(options.site ?? io.env.NAVVIED_WEB_URL ?? DEFAULT_SITE);
  if (!site) return { ok: false, error: "--site must be a web address such as https://navvied.com" };
  const ports = options.port !== undefined ? [options.port] : PORTS;
  let failure = "";
  for (const port of ports) {
    try {
      const started = await startHttpServer({ ...options, http: true, port, allowOrigins: [...(options.allowOrigins ?? []), site] }, io, { ask: (q) => askToPair(io, q), ...(hub ? { hub } : {}), ...(store ? { store } : {}) });
      if (!started.ok) return { ok: false, error: started.error };
      const link = connectLink(site, `http://127.0.0.1:${started.server.port}`, started.server.token);
      io.system.open(link);
      return { ok: true, opened: { server: started.server, link, site } };
    } catch (e) { failure = e instanceof Error ? e.message : String(e); }
  }
  return { ok: false, error: failure.includes("EADDRINUSE") || failure.includes("in use") ? `navvied is already running on ports ${ports.join(", ")}. Close it first, or choose another with --port.` : failure };
}

export async function webCommand(options: Options, io: IO): Promise<number> {
  const opened = await openWeb(options, io);
  if (!opened.ok) { io.stderr.write(`error: ${opened.error}\n`); return EXIT.usage; }
  const { server, link, site } = opened.opened;
  const c = io.color;
  io.stderr.write(`\n  ${paint(c, "cyan", "⬢")} ${paint(c, "bold", "navvied is running on this computer")}\n\n  Opening ${paint(c, "bold", site)} in your browser.\n  It will ask you here, in this window, before it can connect.\n\n`);
  if (!server.connected()) io.stderr.write("  No model is connected yet. Run navvied init in another window; this one picks it up by itself.\n\n");
  io.stderr.write(`  ${paint(c, "dim", "The page did not open? Open this address yourself. It carries the key, so keep it private:")}\n  ${paint(c, "dim", link)}\n\n`);
  io.stderr.write(`  ${paint(c, "dim", "Press Ctrl+C to stop.")}\n`);
  await new Promise<void>((done) => { const off = io.onInterrupt(() => { off(); done(); }); });
  await server.stop();
  return EXIT.ok;
}
