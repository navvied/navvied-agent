import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../src/config.ts";
import type { System } from "../src/system.ts";
import type { IO } from "../src/io.ts";

/** Text chunks you can push into standard input while a command is running. */
export class InputQueue implements AsyncIterable<string> {
  #buffer: string[] = [];
  #waiting: ((r: IteratorResult<string>) => void) | undefined;
  #ended = false;
  push(chunk: string): void {
    if (this.#waiting) { const w = this.#waiting; this.#waiting = undefined; w({ value: chunk, done: false }); } else this.#buffer.push(chunk);
  }
  end(): void { this.#ended = true; if (this.#waiting) { const w = this.#waiting; this.#waiting = undefined; w({ value: undefined, done: true }); } }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const v = this.#buffer.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.#waiting = resolve; });
      },
    };
  }
}

export interface FakeSystem extends System {
  /** What the clipboard holds; change it to simulate a copy. */
  clip: string | undefined;
  opened: string[];
  /** What was put on the clipboard, in order. */
  copied: string[];
  /** Programs "installed": name to path. */
  installed: Record<string, string>;
  /** Answers for programs it is asked to run, by the start of the command line. */
  runs: Record<string, (argv: string[], on: (line: string) => void, input: { onLine(listener: (line: string) => void): void }) => { code: number; output: string } | Promise<{ code: number; output: string }>>;
  ran: string[][];
}

export function fakeSystem(over: Partial<Pick<FakeSystem, "clip" | "installed" | "runs">> = {}): FakeSystem {
  const sys: FakeSystem = {
    clip: over.clip, opened: [], copied: [], installed: over.installed ?? {}, runs: over.runs ?? {}, ran: [],
    clipboard: async () => sys.clip,
    open: (url) => { sys.opened.push(url); },
    copy: async (text) => { sys.copied.push(text); sys.clip = text; return true; },
    which: (command) => sys.installed[command],
    run: async (argv, options = {}) => {
      sys.ran.push(argv);
      const key = Object.keys(sys.runs).sort((a, b) => b.length - a.length).find((k) => argv.join(" ").startsWith(k));
      if (!key) return { code: 127, output: "" };
      let listener: ((line: string) => void) | undefined;
      options.input?.((line) => listener?.(line));
      return sys.runs[key]!(argv, (line) => options.onLine?.(line), { onLine: (l) => { listener = l; } });
    },
  };
  return sys;
}

export function fakeIO(opts: { interactive?: boolean; color?: boolean; env?: Env; stdin?: string; fetch?: typeof fetch; system?: System; dock?: IO["dock"] } = {}) {
  const out: string[] = [], err: string[] = [];
  const input = new InputQueue();
  if (opts.stdin !== undefined) { input.push(opts.stdin); input.end(); }
  const handlers = new Set<() => void>();
  (opts.env ??= {}).NAVVIED_GUEST_MODELS ??= "0";
  const io: IO = {
    stdout: { write: (s) => { out.push(s); } },
    stderr: { write: (s) => { err.push(s); } },
    stdin: input,
    interactive: opts.interactive ?? false,
    color: opts.color ?? false,
    // A test computer never asks navvied.com for its free models.
    env: (opts.env ??= {}),
    system: opts.system ?? fakeSystem(),
    fetch: opts.fetch ?? globalThis.fetch,
    onInterrupt: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
    lines: () => (async function* () {
      let buffer = "";
      for await (const chunk of input) {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) { yield buffer.slice(0, i).replace(/\r$/, ""); buffer = buffer.slice(i + 1); }
      }
      if (buffer) yield buffer;
    })(),
    prompt: (text) => { if (opts.interactive) err.push(text); },
    ...(opts.dock ? { dock: opts.dock } : {}),
  };
  return { io, input, out: () => out.join(""), err: () => err.join(""), interrupt: () => { for (const h of [...handlers]) h(); } };
}

export const tempDir = (): string => mkdtempSync(join(tmpdir(), "navvied-cli-"));
/** Windows lets go of a folder a moment after the program that used it has ended, so a removal is retried. */
export const remove = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

/** A scripted model server (chat-completions API over SSE). It answers from keywords in the latest user message. */
export function startMockModel() {
  const requests: any[] = [];
  const enc = new TextEncoder();
  const sse = (chunks: unknown[], delay = 0) => new Response(new ReadableStream({
    async start(c) {
      for (const x of chunks) { c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); if (delay) await Bun.sleep(delay); }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  const usage = (n: number) => ({ choices: [], usage: { prompt_tokens: n, completion_tokens: 10 } });
  const text = (t: string, n = 100, delay = 0) => sse([...t.split(" ").map((w, i) => ({ choices: [{ delta: { content: (i ? " " : "") + w } }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }, usage(n)], delay);
  const call = (name: string, args: unknown) => {
    const a = JSON.stringify(args);
    return sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: a.slice(0, 8) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(8) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, usage(120),
    ]);
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body: any = await req.json();
      requests.push({ auth: req.headers.get("authorization"), body });
      const messages: any[] = body.messages;
      const system = String(messages[0]?.content ?? "");
      const last = messages.at(-1);
      const user = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      if (!body.stream) return Response.json({ choices: [{ message: { content: "SUMMARY" } }] });
      if (/\bfail\b/.test(user)) return new Response("model is down", { status: 500 });
      if (last?.role === "tool") return text(`done: ${String(last.content).replace(/\s+/g, " ").slice(0, 60)}`);
      if (system.includes("PLAN MODE") && /\bplan\b/.test(user)) return call("ExitPlanMode", { plan: "1. First step\n2. Second step" });
      const write = /\bwrite (\S+)/.exec(user);
      if (write) return call("Write", { file_path: write[1], content: "hello from the agent\n" });
      if (/\bbash\b/.test(user)) return call("Bash", { command: "echo from-shell" });
      const fetchUrl = /\bfetch (\S+)/.exec(user);
      if (fetchUrl) return call("WebFetch", { url: fetchUrl[1] });
      if (/\bslow\b/.test(user)) return text("thinking for a long while before answering", 100, 400);
      return text("all done here");
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("condition not met in time"); await wait(10); }
}
