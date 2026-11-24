/**
 * Connecting a model without a terminal: what the page needs to find a model on this computer, try a service, and keep it.
 * Keys are written to the private configuration file and never sent back.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Result } from "@navvied/protocol";
import { loadConfig, parseModelEntry, type ConfigFile, type ModelEntry } from "./config.ts";
import { describeEntry } from "./create.ts";
import { SIGN_IN_PROGRAMS, authHeaders, localName, memoryFor, type LocalServer } from "./presets.ts";
import type { IO } from "./io.ts";

const LOCAL_PORTS = [11434, 1234, 8080, 8000];

/** Look for model servers on this machine that speak the chat-completions API. */
export async function findLocalServers(fetchFn: typeof fetch): Promise<LocalServer[]> {
  const probes = LOCAL_PORTS.map(async (port): Promise<LocalServer | undefined> => {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
      const res = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(700) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
      return { name: localName(baseUrl), baseUrl, models, ...(port === 11434 ? { ollama: true } : {}) };
    } catch { return undefined; }
  });
  return (await Promise.all(probes)).filter((s): s is LocalServer => s !== undefined);
}

/** Whether a model's server answers its list of models, with the key it has. */
export async function reachable(entry: ModelEntry, env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<boolean> {
  if (!entry.baseUrl) return false;
  const key = (entry.apiKeyEnv ? env[entry.apiKeyEnv] : undefined) ?? entry.apiKey;
  const root = entry.baseUrl.replace(/\/+$/, "");
  try {
    const res = await fetchFn(entry.api === "ollama" ? `${root}/api/tags` : `${root}/models`, { headers: authHeaders(entry.api, key), signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

export interface SetupView {
  servers: { name: string; baseUrl: string; models: string[]; ollama: boolean }[];
  /** The programs a person can sign in to, with whether each is installed. The label is ready to show. */
  programs: { id: string; label: string; installed: boolean }[];
  models: { name: string; label: string; how: string; current: boolean }[];
}

/** What is on this computer, and what is already connected. No key is ever part of it. */
export async function discover(io: IO, file: ConfigFile | null): Promise<SetupView> {
  const servers = await findLocalServers(io.fetch);
  return {
    servers: servers.map((s) => ({ name: s.name, baseUrl: s.baseUrl, models: s.models, ollama: s.ollama === true })),
    programs: SIGN_IN_PROGRAMS.map((p) => ({ id: p.id, label: p.label, installed: io.system.which(p.command) !== undefined })),
    models: Object.entries(file?.models ?? {}).map(([name, e]) => ({ name, label: e.model ?? name, how: describeEntry(e), current: name === file?.default })),
  };
}

export type Listing = { ok: true; models: string[] } | { ok: false; reason: "unauthorised" | "unreachable" | "no-models" };

/** Asks a service for its models, which also shows whether the address and the key are right. */
export async function listModels(fetchFn: typeof fetch, input: { baseUrl: string; apiKey?: string; api?: ModelEntry["api"] }): Promise<Listing> {
  if (!/^https?:\/\//.test(input.baseUrl)) return { ok: false, reason: "unreachable" };
  const root = input.baseUrl.replace(/\/+$/, "");
  try {
    const url = input.api === "ollama" ? `${root}/api/tags` : `${root}/models`;
    const res = await fetchFn(url, { headers: authHeaders(input.api, input.apiKey), signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorised" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    const body = (await res.json()) as { data?: { id?: unknown }[]; models?: { name?: unknown }[] };
    const ids = (input.api === "ollama" ? (body.models ?? []).map((m) => m.name) : (body.data ?? []).map((m) => m.id)).filter((id): id is string => typeof id === "string").sort();
    return ids.length ? { ok: true, models: ids } : { ok: false, reason: "no-models" };
  } catch { return { ok: false, reason: "unreachable" }; }
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "model";

export interface SaveInput { name?: string; baseUrl: string; api?: string; model: string; apiKey?: string; window?: number; makeDefault?: boolean }

/** Checks and keeps one model. The file is private (mode 0600) because it may hold a key. */
export async function saveModel(path: string, input: SaveInput, fetchFn: typeof fetch): Promise<Result<{ name: string }>> {
  const loaded = loadConfig(path);
  if (!loaded.ok) return loaded;
  const config: ConfigFile = loaded.value ?? { models: {} };
  const name = slug(input.name ?? input.model);
  const raw: Record<string, unknown> = { baseUrl: input.baseUrl, model: input.model, ...(input.api ? { api: input.api } : {}), ...(input.apiKey ? { apiKey: input.apiKey } : {}) };
  if (input.api === "ollama") raw.window = await memoryFor(fetchFn, input.baseUrl.replace(/\/+$/, ""), input.model);
  else if (typeof input.window === "number") raw.window = input.window;
  const checked = parseModelEntry(name, raw);
  if (!checked.ok) return checked;
  config.models[name] = checked.value;
  if (input.makeDefault !== false || !config.default) config.default = name;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
  return { ok: true, value: { name } };
}

/** Makes another connected model the one to use. */
export function useModel(path: string, name: string): Result<{ name: string }> {
  const loaded = loadConfig(path);
  if (!loaded.ok) return loaded;
  if (!loaded.value?.models[name]) return { ok: false, error: `there is no model "${name}"` };
  loaded.value.default = name;
  writeFileSync(path, `${JSON.stringify(loaded.value, null, 2)}\n`);
  chmodSync(path, 0o600);
  return { ok: true, value: { name } };
}
