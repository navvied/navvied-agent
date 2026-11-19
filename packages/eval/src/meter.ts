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
  status: number;
  /** From the request to the end of the answer. */
  ms: number;
}

export interface Meter {
  port: number;
  /** The base address an agent is given for one run: the model's own address, seen through the counter. */
  url(run: string): string;
  /** What went through for this run, in the order it arrived, once the answers still being read are in; the run is forgotten. */
  take(run: string): Promise<Hit[]>;
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

export function startMeter(upstream: string): Meter {
  const target = new URL(upstream);
  const basePath = target.pathname.replace(/\/+$/, "");
  const hits = new Map<string, Hit[]>();
  const open = new Map<string, number>();
  const opened = (run: string, by: number): void => { open.set(run, (open.get(run) ?? 0) + by); };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/run\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!m) return new Response("not a run of the counter", { status: 404 });
      const [, run, path] = m as unknown as [string, string, string];
      const started = Date.now();
      opened(run, 1);
      const raw = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined; } catch { /* not JSON: passed on as it is */ }
      const headers = new Headers(req.headers);
      for (const h of ["host", "content-length", "accept-encoding"]) headers.delete(h);
      let res: Response;
      try {
        res = await fetch(`${target.origin}${path}${url.search}`, { method: req.method, headers, ...(raw ? { body: raw } : {}), signal: req.signal });
      } catch (e) {
        record(run, { at: started, path, stream: false, requestBytes: raw?.length ?? 0, ...weigh(path, parsed), inTokens: 0, outTokens: 0, estimated: true, status: 502, ms: Date.now() - started });
        return new Response(`the counter could not reach the model: ${e instanceof Error ? e.message : String(e)}`, { status: 502 });
      }
      const counted = /\/(chat\/completions|messages)$/.test(path) && parsed !== undefined;
      const out = new Headers(res.headers);
      for (const h of ["content-encoding", "content-length", "transfer-encoding"]) out.delete(h);
      if (!counted || !res.body) { opened(run, -1); return new Response(res.body, { status: res.status, headers: out }); }
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
        record(run, { at: started, path, stream, requestBytes: bytes, ...weigh(path, parsed), inTokens: got.in ?? Math.ceil(bytes / 4), outTokens: got.out ?? 0, estimated: got.in === undefined || got.out === undefined, status: res.status, ms: Date.now() - started });
      })();
      return new Response(toClient, { status: res.status, headers: out });
    },
  });

  const record = (run: string, hit: Hit): void => { const list = hits.get(run) ?? []; list.push(hit); hits.set(run, list); opened(run, -1); };

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
    stop: () => server.stop(true),
  };
}
