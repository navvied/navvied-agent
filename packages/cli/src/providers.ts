import type { ProviderSaved } from "@navvied/protocol";
import type { AdcPlaces } from "./adc.ts";
import type { ModelEntry } from "./config.ts";

/** One region of a provider: a key made in one region works only there, so the region picks the address. */
export interface ProviderRegion { id: string; label: string; base: string; keyUrl?: string }

/** What a provider asks for besides the key. A secret field is never reported back; `header` sends the value as that header of every request. */
export interface ProviderField { id: string; label: string; ph?: string; secret?: true; required?: true; header?: string }

/**
 * One provider a person can use with a key of their own (the data is in `presets.ts`, the one place that names them).
 * `base` may hold `{field}` for the value of a field (a resource name); `regions` replaces it when the provider has one address per region.
 */
export interface ProviderEntry {
  id: string;
  name: string;
  base?: string;
  regions?: ProviderRegion[];
  fields?: ProviderField[];
  /** How the API is spoken (the default is chat completions). */
  api?: ModelEntry["api"];
  /** The header that carries the key as it is. The default is `Authorization: Bearer`. */
  keyHeader?: string;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** The key is optional (a local server, or another way to sign in). */
  keyOptional?: true;
  keyLabel?: string;
  keyNote?: string;
  getKey?: string;
  /**
   * The provider's own list of models says, for each model, which protocols reach it and at which address (`api: { <protocol>: { base_url } }`).
   * These are the protocols this program speaks, in order of preference when a model has several and names none.
   */
  routes?: ProviderRoute[];
  /** No key: the access token comes from a credential file of this computer (adc.ts), looked for in these places. */
  adc?: AdcPlaces;
  /** The provider asks for a stable id of the conversation in this header: one is made when a model is chosen and kept with it. */
  sessionHeader?: string;
  /** `community`: the address or the header was never printed by the provider itself; it is what widely used open tools ship and what the provider's own pages leave open (see the evidence notes). Absent: every fact has a line of the provider's own pages. */
  evidence?: "community";
  /** The provider lets this key be used only in a coding tool the person runs (no script, no server): only this computer may keep it, never a cloud session. */
  interactiveOnly?: true;
}

/** How one of the protocols a provider lists for its models is spoken here. A protocol that is not in the list of an entry is not spoken, and the models that only have such routes are left out with the reason. */
export type RouteApi = "chat" | "responses" | "messages";
export interface ProviderRoute { protocol: string; api: RouteApi }

/** What a computer keeps for one provider. Written to the configuration file, which only its owner can read. */
export interface SavedProvider { key?: string; region?: string; fields?: Record<string, string> }

const missing = (e: ProviderEntry, saved: SavedProvider): string | undefined => {
  if (e.regions && !e.regions.some((r) => r.id === saved.region)) return "a region";
  const field = e.fields?.find((f) => f.required && !saved.fields?.[f.id]);
  return field ? field.label : undefined;
};

/** The address calls go to, or what is still missing before there is one. */
export function baseOf(e: ProviderEntry, saved: SavedProvider): { base: string } | { missing: string } {
  const lacking = missing(e, saved);
  if (lacking) return { missing: lacking };
  const region = e.regions?.find((r) => r.id === saved.region);
  const raw = region?.base ?? e.base ?? "";
  return { base: raw.replace(/\{(\w+)\}/g, (_, id: string) => encodeURIComponent(saved.fields?.[id] ?? "")) };
}

/** Every header a request to the provider carries besides what the API itself needs: the key when it is not a bearer token, the fixed ones, and the fields that are headers. */
export function headersOf(e: ProviderEntry, saved: SavedProvider): Record<string, string> {
  const out: Record<string, string> = { ...e.headers };
  if (saved.key && e.keyHeader) out[e.keyHeader] = saved.key;
  for (const f of e.fields ?? []) { const v = saved.fields?.[f.id]; if (f.header && v) out[f.header] = v; }
  return out;
}

/** The entry of the configuration that runs `model` with what is saved, or why it cannot be made yet. */
export function modelEntryOf(e: ProviderEntry, saved: SavedProvider, model: string, route?: ListedRoute, session?: string, credentialFile?: string): { entry: ModelEntry } | { missing: string } {
  const where = baseOf(e, saved);
  if ("missing" in where) return where;
  if (!saved.key && !e.keyOptional && !e.adc) return { missing: e.keyLabel ?? "a key" };
  if (e.adc && !credentialFile) return { missing: "a credential file" };
  const headers = { ...headersOf(e, saved), ...(e.sessionHeader && session ? { [e.sessionHeader]: session } : {}) };
  const api = route?.api ?? e.api;
  return { entry: { baseUrl: route?.base ?? where.base, model, ...(api ? { api } : {}), ...(saved.key && !e.keyHeader ? { apiKey: saved.key } : {}), ...(e.adc && credentialFile ? { adc: { file: credentialFile, tokenUri: e.adc.tokenUri, scope: e.adc.scope } } : {}), ...(Object.keys(headers).length ? { headers } : {}) } };
}

/** What may be said about what is saved: that a key is there and the values that are not secret. */
export function reportOf(entries: readonly ProviderEntry[], saved: Record<string, SavedProvider>): ProviderSaved[] {
  const out: ProviderSaved[] = [];
  for (const e of entries) {
    const s = saved[e.id];
    if (!s) continue;
    const secret = new Set((e.fields ?? []).filter((f) => f.secret).map((f) => f.id));
    const fields = Object.fromEntries(Object.entries(s.fields ?? {}).filter(([id]) => !secret.has(id)));
    out.push({ id: e.id, key: !!s.key, ...(s.region ? { region: s.region } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
  }
  return out;
}

/** The values to save for a request from a page: only the fields the provider has, a key kept when none is sent, a field sent empty taken away. */
export function mergeSaved(e: ProviderEntry, before: SavedProvider | undefined, patch: { key?: string; region?: string; fields?: Record<string, string> }): { saved: SavedProvider } | { error: string } {
  if (e.adc && patch.key !== undefined) return { error: `${e.name} takes no key: it signs in with a credential file of this computer` };
  if (patch.region !== undefined && !e.regions?.some((r) => r.id === patch.region)) return { error: `${e.name} has no region ${patch.region}` };
  const known = new Set((e.fields ?? []).map((f) => f.id));
  for (const id of Object.keys(patch.fields ?? {})) if (!known.has(id)) return { error: `${e.name} has no field ${id}` };
  const fields = { ...before?.fields, ...patch.fields };
  for (const id of Object.keys(fields)) if (!fields[id]) delete fields[id];
  const key = patch.key ?? before?.key;
  const region = patch.region ?? before?.region;
  return { saved: { ...(key ? { key } : {}), ...(region ? { region } : {}), ...(Object.keys(fields).length ? { fields } : {}) } };
}

const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
/** The name an entry of the configuration gets for a model of a provider. */
export const entryName = (e: ProviderEntry, model: string): string => `${e.id}-${slug(model)}`;

/** Why a list could not be had: the key was refused, there is no list to ask for, or the provider could not be asked just now. */
export interface ListError { error: string; kind: "refused" | "none" | "failed" }
export interface ListedRoute { api: RouteApi; base: string }
export interface ListedModel { id: string; route?: ListedRoute }
export interface SkippedModel { id: string; reason: string }

type RawModel = { id?: unknown; recommended_api?: unknown; api?: unknown };

/** The route of a model from what the provider's list says about it: the one it recommends when this program speaks it, else the first spoken one. */
function routeOf(e: ProviderEntry, m: RawModel): { route: ListedRoute } | { reason: string } {
  const api = typeof m.api === "object" && m.api !== null && !Array.isArray(m.api) ? (m.api as Record<string, { base_url?: unknown }>) : {};
  const named = Object.keys(api);
  const spoken = (e.routes ?? []).filter((r) => typeof api[r.protocol]?.base_url === "string");
  const pick = spoken.find((r) => r.protocol === m.recommended_api) ?? spoken[0];
  if (!pick) return { reason: named.length ? `it is reached through ${named.join(", ")}, which this program does not speak` : "the provider lists no route for it" };
  return { route: { api: pick.api, base: String(api[pick.protocol]!.base_url).replace(/\/+$/, "") } };
}

/**
 * The models a provider lists, asked with the key it was given; what went wrong is said so that a person can act on it. For a provider whose list names a route per
 * model, each model carries its route, and the models that no spoken route reaches are returned apart, each with its reason (never guessed).
 */
export async function listModels(e: ProviderEntry, base: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<{ models: ListedModel[]; skipped: SkippedModel[] } | ListError> {
  try {
    const res = await fetchFn(`${base.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { error: "The provider did not accept the key.", kind: "refused" };
    if (res.status === 404 || res.status === 405 || res.status === 501) return { error: `${e.name} has no list of models to ask for.`, kind: "none" };
    if (!res.ok) return { error: `The provider answered ${res.status}.`, kind: "failed" };
    const body = (await res.json()) as { data?: RawModel[] };
    const models: ListedModel[] = [], skipped: SkippedModel[] = [];
    for (const m of body.data ?? []) {
      if (typeof m.id !== "string") continue;
      if (!e.routes) { models.push({ id: m.id }); continue; }
      const got = routeOf(e, m);
      if ("route" in got) models.push({ id: m.id, route: got.route }); else skipped.push({ id: m.id, reason: got.reason });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    skipped.sort((a, b) => a.id.localeCompare(b.id));
    return models.length ? { models, skipped } : { error: "The provider sent no list of models.", kind: "none" };
  } catch { return { error: "The provider could not be reached.", kind: "failed" }; }
}

/** The entry of the configuration a model made from a provider stands for right now: what is saved for the provider is read here, never copied into the model. */
export function expandModel(catalogue: readonly ProviderEntry[], saved: Record<string, SavedProvider> | undefined, m: ModelEntry): { entry: ModelEntry } | { error: string } {
  const e = catalogue.find((c) => c.id === m.provider);
  if (!e) return { error: "That provider is not known." };
  const made = modelEntryOf(e, saved?.[e.id] ?? {}, m.model ?? "", m.route, m.session, m.credential);
  if ("missing" in made) return { error: `Add ${made.missing} for ${e.name} first.` };
  const { provider: _p, route: _r, session: _s, credential: _c, ...own } = m;
  return { entry: { ...own, ...made.entry } };
}

/** What must never be shown in any output: the keys and the secret fields of everything saved. (A region, a project or a place is not a secret.) */
export function savedSecrets(catalogue: readonly ProviderEntry[], saved: Record<string, SavedProvider> | undefined): string[] {
  const out: string[] = [];
  for (const [id, s] of Object.entries(saved ?? {})) {
    if (s.key) out.push(s.key);
    const secret = new Set((catalogue.find((c) => c.id === id)?.fields ?? []).filter((f) => f.secret).map((f) => f.id));
    for (const [field, value] of Object.entries(s.fields ?? {})) if (secret.has(field) && value) out.push(value);
  }
  return out;
}
