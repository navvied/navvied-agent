/**
 * Fetching a model through the Ollama of this computer, when the person has it: its own `/api/pull` does the work and keeps the model, so nothing of it is stored or
 * checked here. Progress is the sum of its layers (`digest`, `total`, `completed` on each line of the stream); stopping closes the request, and Ollama takes up the
 * layers that were fetched at the next pull.
 */
export type OllamaState = { state: "missing" } | { state: "ready"; baseUrl: string; version: string; models: string[] };
export type OllamaPullState = { state: "downloading" | "verifying"; bytes: number; total: number } | { state: "done" } | { state: "failed"; error: string } | { state: "idle" };

/** Where Ollama listens: what its own `OLLAMA_HOST` says (a bare host or port is allowed), else the port it starts on. Always an address on this computer. */
export function ollamaRoot(env: Record<string, string | undefined>): string {
  const raw = (env.OLLAMA_HOST ?? "").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw.startsWith(":") ? "127.0.0.1" : ""}${raw}`;
  try {
    const u = new URL(raw ? withScheme : "http://127.0.0.1");
    const host = u.hostname === "0.0.0.0" || u.hostname === "[::]" || u.hostname === "::" || !u.hostname ? "127.0.0.1" : u.hostname;
    return `${u.protocol}//${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${u.port || "11434"}`;
  } catch { return "http://127.0.0.1:11434"; }
}

export async function askOllama(fetchFn: typeof fetch, root: string): Promise<OllamaState> {
  try {
    const v = await fetchFn(`${root}/api/version`, { signal: AbortSignal.timeout(3000) });
    const version = v.ok ? ((await v.json().catch(() => ({}))) as { version?: unknown }).version : undefined;
    if (typeof version !== "string") return { state: "missing" };
    const t = await fetchFn(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    const tags = t?.ok ? ((await t.json().catch(() => ({}))) as { models?: { name?: unknown }[] }).models : undefined;
    return { state: "ready", baseUrl: root, version, models: (Array.isArray(tags) ? tags : []).flatMap((m) => (typeof m?.name === "string" ? [m.name] : [])).sort() };
  } catch { return { state: "missing" }; }
}

export async function pullOllama(o: { fetchFn: typeof fetch; root: string; model: string; signal: AbortSignal; onState(s: OllamaPullState): void }): Promise<{ ok: true } | { ok: false; why: "cancelled" | "failed" }> {
  const fail = (error: string): { ok: false; why: "failed" } => { o.onState({ state: "failed", error }); return { ok: false, why: "failed" }; };
  let res: Response;
  try { res = await o.fetchFn(`${o.root}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: o.model, stream: true }), signal: o.signal }); }
  catch { return o.signal.aborted ? cancelled(o) : fail("Ollama could not be reached. Start it and try again."); }
  if (!res.ok || !res.body) {
    const said = ((await res.json().catch(() => ({}))) as { error?: unknown }).error;
    return fail(typeof said === "string" && said ? `Ollama said: ${said.slice(0, 300)}` : `Ollama answered ${res.status}.`);
  }
  const layers = new Map<string, { total: number; completed: number }>();
  let success = false, buffered = "";
  const line = (text: string): string | undefined => {
    let j: { status?: unknown; error?: unknown; digest?: unknown; total?: unknown; completed?: unknown };
    try { j = JSON.parse(text) as typeof j; } catch { return undefined; }
    if (typeof j.error === "string") return j.error;
    if (typeof j.digest === "string" && typeof j.total === "number") layers.set(j.digest, { total: j.total, completed: typeof j.completed === "number" ? j.completed : 0 });
    const status = typeof j.status === "string" ? j.status : "";
    if (status === "success") { success = true; return undefined; }
    const all = [...layers.values()];
    o.onState({ state: /^verifying/i.test(status) ? "verifying" : "downloading", bytes: all.reduce((n, l) => n + l.completed, 0), total: all.reduce((n, l) => n + l.total, 0) });
    return undefined;
  };
  try {
    const decoder = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const said = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        const error = said ? line(said) : undefined;
        if (error) return fail(`Ollama said: ${error.slice(0, 300)}`);
      }
    }
    const rest = buffered.trim();
    const error = rest ? line(rest) : undefined;
    if (error) return fail(`Ollama said: ${error.slice(0, 300)}`);
  } catch { return o.signal.aborted ? cancelled(o) : fail("The connection to Ollama was lost. Pull again to go on where it stopped."); }
  if (!success) return fail("Ollama stopped before the model was ready. Pull again to go on where it stopped.");
  o.onState({ state: "done" });
  return { ok: true };
}

function cancelled(o: { onState(s: OllamaPullState): void }): { ok: false; why: "cancelled" } {
  o.onState({ state: "idle" });
  return { ok: false, why: "cancelled" };
}
