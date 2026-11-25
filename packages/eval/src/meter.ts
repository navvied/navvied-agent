/**
 * The counter: a server the agent is pointed at instead of its model. It passes every request on to the real model and writes down
 * what went through, so calls, tokens and the weight of the prompt are counted the same way for every agent, whatever the agent
 * itself reports. It speaks the two protocols the models are reached with (chat completions and messages) and passes anything
 * else on untouched.
 */

export interface Hit {
  /** When the request arrived (milliseconds since 1970). */
  at: number;
  path: string;
  stream: boolean;
  requestBytes: number;
  /** Characters of the system prompt. */
  systemChars: number;
  /** How many tools the request offers, and the characters of their definitions as sent. */
  tools: number;
  toolChars: number;
  messages: number;
  inTokens: number;
  outTokens: number;
  /** The answer carried no token counts: these are characters divided by four. */
  estimated: boolean;
  /** What the model answered with; 499 when the one who asked gave up before it did (the agent was stopped), which is not the model failing. */
  status: number;
  /** From the request to the end of the answer. */
  ms: number;
  /** Time the counter itself waited before the model got the request: to keep to the service's rate, and to back off after "too many requests". It is not the model's time. */
  waitedMs: number;
}

/** What a service allows an account, kept to by the counter so that no agent has to. */
export interface MeterLimits {
  /** Requests to the model per minute: they are spaced evenly, and an answer of "too many requests" is waited out and the request sent again. */
  perMinute?: number;
  /** The most tokens (in and out, as counted) that may go through in all: a request that would pass it is refused (status 402) and nothing more is sent. */
  maxTokens?: number;
  /** Time as the counter reads it and waits for it: real time unless a test sets it (so spacing is checked by the numbers it waits, not by how long a loaded computer took). */
  clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
}

export interface Meter {
  port: number;
  /** The base address an agent is given for one run: the model's own address, seen through the counter. */
  url(run: string): string;
  /** What went through for this run, in the order it arrived, once the answers still being read are in; the run is forgotten. */
  take(run: string): Promise<Hit[]>;
  /** Tokens counted so far over all runs, and whether a request was refused for passing the limit. */
  spent(): number;
  exhausted(): boolean;
  stop(): void;
}

const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? v.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "");

/** What the request says about the prompt: the system text, the tools offered, the messages. */
function weigh(path: string, body: unknown): Pick<Hit, "systemChars" | "tools" | "toolChars" | "messages"> {
  const b = (body && typeof body === "object" ? body : {}) as { messages?: { role?: string; content?: unknown }[]; system?: unknown; tools?: unknown[] };
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const system = path.endsWith("/messages") ? text(b.system) : messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("");
  return { systemChars: system.length, tools: tools.length, toolChars: tools.length ? JSON.stringify(tools).length : 0, messages: messages.length };
}

/** The tokens an answer says it used, from its JSON or from the events of a stream. */
function tokensOf(data: unknown, into: { in?: number; out?: number }): void {
  type Usage = { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  const d = data as { usage?: Usage; message?: { usage?: Usage } };
  for (const u of [d.usage, d.message?.usage]) {
    if (!u) continue;
    const input = u.prompt_tokens ?? u.input_tokens, output = u.completion_tokens ?? u.output_tokens;
    if (typeof input === "number") into.in = input;
    if (typeof output === "number") into.out = output;
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((done) => { const t = setTimeout(done, ms); signal?.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); });
/** How many times a request is sent again after "too many requests", when the rate is kept to. */
const AGAIN = 8;

export function startMeter(upstream: string, limits: MeterLimits = {}): Meter {
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/+$/, "");
  const hits = new Map<string, Hit[]>();
  const open = new Map<string, number>();
  // One request at a time reaches the model, whatever the agent does: a model on a machine that also does other work is not to be loaded harder.
  let tail: Promise<void> = Promise.resolve();
  const enter = async (): Promise<() => void> => { let release!: () => void; const before = tail; tail = new Promise<void>((r) => { release = r; }); await before; return release; };
  const opened = (run: string, by: number): void => { open.set(run, (open.get(run) ?? 0) + by); };
  const now = limits.clock?.now ?? Date.now;
  const pause = limits.clock?.sleep ?? sleep;
  const gap = limits.perMinute ? 60_000 / limits.perMinute : 0;
  let last = 0, spent = 0, refused = false;
  /** Waits until the service's rate allows another request; says how long it waited. */
  const spaced = async (signal: AbortSignal): Promise<number> => { const wait = Math.max(0, last + gap - now()); if (wait) await pause(wait, signal); last = now(); return wait; };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/run\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!m) return new Response("not a run of the counter", { status: 404 });
      const [, run, path] = m as unknown as [string, string, string];
      const started = now();
      opened(run, 1);
      const raw = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined; } catch { /* not JSON: passed on as it is */ }
      const counted = /\/(chat\/completions|messages)$/.test(path) && parsed !== undefined;
      const release = counted ? await enter() : () => undefined;
      const headers = new Headers(req.headers);
      for (const h of ["host", "content-length", "accept-encoding"]) headers.delete(h);
      if (counted && limits.maxTokens !== undefined && spent + Math.ceil((raw?.length ?? 0) / 4) > limits.maxTokens) {
        refused = true;
        release(); opened(run, -1);
        return new Response("the token limit of this measurement is reached", { status: 402 });
      }
      let res: Response;
      let waitedMs = 0;
      try {
        for (let again = 0; ; again++) {
          if (counted && gap) waitedMs += await spaced(req.signal);
          res = await fetch(`${target.origin}${path}${url.search}`, { method: req.method, headers, ...(raw ? { body: raw } : {}), signal: req.signal });
          if (res.status !== 429 || !gap || again >= AGAIN || req.signal.aborted) break;
          await res.body?.cancel();
          const hint = Number(res.headers.get("retry-after"));
          const backoff = Number.isFinite(hint) && hint > 0 ? hint * 1000 : Math.min(60_000, 2_000 * 2 ** again);
          await pause(backoff, req.signal);
          waitedMs += backoff;
        }
      } catch (e) {
        release();
        // The agent was stopped (its time was up, or it was told to stop) while the model had not answered: the model did not fail.
        const gaveUp = req.signal.aborted;
        record(run, { at: started, path, stream: false, requestBytes: raw?.length ?? 0, ...weigh(path, parsed), inTokens: Math.ceil((raw?.length ?? 0) / 4), outTokens: 0, estimated: true, status: gaveUp ? 499 : 502, ms: Date.now() - started, waitedMs });
        return new Response(`the counter could not reach the model: ${e instanceof Error ? e.message : String(e)}`, { status: gaveUp ? 499 : 502 });
      }
      const out = new Headers(res.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding"]) out.delete(h);
      if (!counted || !res.body) { release(); opened(run, -1); return new Response(res.body, { status: res.status, headers: out }); }
      const stream = (res.headers.get("content-type") ?? "").includes("event-stream");
      const [toClient, toCounter] = res.body.tee();
      void (async () => {
        const got: { in?: number; out?: number } = {};
        let answer = "";
        try {
          const reader = toCounter.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (!stream) { answer += chunk; continue; }
            pending += chunk;
            for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
              const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
              if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
              try { tokensOf(JSON.parse(line.slice(5)), got); } catch { /* a line that is not JSON */ }
            }
          }
          if (!stream) { try { tokensOf(JSON.parse(answer), got); } catch { /* an error page, not an answer */ } }
        } catch { /* the client went away: what was seen is counted */ }
        const bytes = raw?.length ?? 0;
        record(run, { at: started, path, stream, requestBytes: bytes, ...weigh(path, parsed), inTokens: got.in ?? Math.ceil(bytes / 4), outTokens: got.out ?? 0, estimated: got.in === undefined || got.out === undefined, status: res.status, ms: Date.now() - started, waitedMs });
        release();
      })();
      return new Response(toClient, { status: res.status, headers: out });
    },
  });

  const record = (run: string, hit: Hit): void => { spent += hit.inTokens + hit.outTokens; const list = hits.get(run) ?? []; list.push(hit); hits.set(run, list); opened(run, -1); };

  return {
    port: server.port ?? 0,
    url: (run) => `http://127.0.0.1:${server.port}/run/${encodeURIComponent(run)}${basePath}`,
    take: async (run) => {
      for (let i = 0; i < 40 && (open.get(run) ?? 0) > 0; i++) await new Promise((r) => setTimeout(r, 50));
      const list = (hits.get(run) ?? []).sort((a, b) => a.at - b.at);
      hits.delete(run);
      open.delete(run);
      return list;
    },
    spent: () => spent,
    exhausted: () => refused,
    stop: () => server.stop(true),
  };
}
