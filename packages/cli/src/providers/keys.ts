import type { ProviderSaved } from "@navvied/protocol";
import type { Choice } from "../io.ts";
import { PROVIDERS } from "../presets.ts";
import type { ProviderEntry } from "../providers.ts";
import type { Kit, Result } from "./kit.ts";

const regionLabel = (e: ProviderEntry, id: string | undefined): string | undefined => e.regions?.find((r) => r.id === id)?.label;
const keyLabel = (e: ProviderEntry): string => e.keyLabel ?? `${e.name} key`;
const baseOf = (e: ProviderEntry, region: string | undefined): string => e.regions?.find((r) => r.id === region)?.base ?? e.regions?.[0]?.base ?? e.base ?? "";

/** A service has what it needs saved: a key, or for one that signs in with a file of this computer, a file that was found. */
const isSaved = (e: ProviderEntry, s: ProviderSaved | undefined): boolean => !!s && (e.adc ? !!s.credential : s.key);

/** The services a person can add a key for, with a dot on the ones that have one. */
export function providerRows(entries: readonly ProviderEntry[], saved: readonly ProviderSaved[]): (Choice & { id: string })[] {
  return entries.map((e) => ({ id: e.id, label: `${isSaved(e, saved.find((x) => x.id === e.id)) ? "●" : " "} ${e.name}` }));
}

/** What the person has changed on the page of one service, not yet saved. `key` is only set when a new one was pasted. */
export interface Draft { region?: string; key?: string; base?: string; fields: Record<string, string> }
type Act = "region" | "key" | "base" | "save" | "remove" | "model" | { field: string };

/** The page of one service: region, key, the other fields, another address, then Save and Remove. */
export function pageRows(e: ProviderEntry, saved: ProviderSaved | undefined, d: Draft): (Choice & { act: Act })[] {
  const rows: (Choice & { act: Act })[] = [];
  if (e.regions) rows.push({ label: "Region", hint: regionLabel(e, d.region ?? saved?.region ?? e.regions[0]!.id), act: "region" });
  for (const f of e.fields ?? []) {
    const value = d.fields[f.id] ?? (f.secret ? (saved?.fields?.[f.id] ? "Saved" : "") : saved?.fields?.[f.id]);
    rows.push({ label: f.label, ...(f.secret && d.fields[f.id] ? { hint: "••••••••" } : value || f.ph ? { hint: value || f.ph } : {}), act: { field: f.id } });
  }
  if (!e.adc) rows.push({ label: keyLabel(e), hint: d.key ? "••••••••" : saved?.key ? "Saved" : `Paste ${keyLabel(e)}`, act: "key" });
  rows.push({ label: `${e.name} base URL override`, hint: d.base ?? saved?.base ?? baseOf(e, d.region ?? saved?.region), act: "base" });
  rows.push({ label: "Save", act: "save" });
  if (isSaved(e, saved) || saved?.base) rows.push({ label: "Remove", act: "remove" });
  return rows;
}

/** API keys: every service, and for each its page, where a key is pasted and saved, and one of its models chosen. */
export async function keysScreen(k: Kit, entries: readonly ProviderEntry[] = PROVIDERS): Promise<Result> {
  let at = 0;
  for (;;) {
    const got = await k.link.call("providers", { cmd: "providers" });
    if (typeof got === "string") { k.note = [got]; return "back"; }
    const rows = providerRows(entries, got.items);
    const picked = await k.choose("API keys", "API keys", rows, { at });
    if (picked === undefined) return "back";
    at = picked;
    const entry = entries.find((p) => p.id === rows[picked]?.id);
    if (!entry) return "back";
    if ((await page(k, entry, got.items.find((x) => x.id === entry.id))) === "switched") return "switched";
  }
}

async function page(k: Kit, e: ProviderEntry, saved: ProviderSaved | undefined): Promise<Result | "again"> {
  const d: Draft = { fields: {} };
  let at = 0;
  const url = (): string | undefined => e.regions?.find((r) => r.id === (d.region ?? saved?.region ?? e.regions?.[0]?.id))?.keyUrl ?? e.getKey;
  for (;;) {
    const rows = pageRows(e, saved, d);
    const body = [...(e.keyNote ? [e.keyNote] : []), ...(url() ? [`Get a key: ${url()}`] : [])];
    const picked = await k.choose(e.name, "API keys", rows, { at, body });
    if (picked === undefined) return "again";
    at = picked;
    const act = rows[picked]!.act;
    if (act === "region") { const r = await k.choose("Region", e.name, (e.regions ?? []).map((x) => ({ label: x.label }))); if (r !== undefined) d.region = e.regions![r]!.id; }
    else if (act === "key") { const key = await k.secret(`Paste ${keyLabel(e)}`, k.frame(e.name, ...body)); if (key) d.key = key; }
    else if (act === "base") { const b = await k.text(`${e.name} base URL override`, k.frame(e.name, baseOf(e, d.region ?? saved?.region)), d.base ?? saved?.base ?? ""); if (b !== undefined) d.base = b; }
    else if (act === "save") {
      const result = await save(k, e, d);
      if (result.kind === "saved") { saved = result.saved; Object.assign(d, { key: undefined, base: undefined, fields: {} }); const next = await chooseModel(k, e); if (next !== "again") return next; }
    }
    else if (act === "remove") {
      const got = await k.link.call("providers", { cmd: "provider.remove", id: e.id });
      k.note = [typeof got === "string" ? got : `${e.name} key removed.`];
      return "again";
    }
    else if (typeof act === "object") {
      const f = e.fields?.find((x) => x.id === act.field)!;
      const frame = k.frame(e.name, ...(f.ph ? [f.ph] : []));
      const text = f.secret ? await k.secret(f.label, frame) : await k.text(f.label, frame, d.fields[f.id] ?? saved?.fields?.[f.id] ?? "");
      if (text !== undefined) d.fields[f.id] = text;
    }
  }
}

/** Keeps what was changed. A key the service refuses is not kept: the hub says so, and the page stays as it was. */
async function save(k: Kit, e: ProviderEntry, d: Draft): Promise<{ kind: "saved"; saved: ProviderSaved } | { kind: "refused" }> {
  const got = await k.link.call("providers", { cmd: "provider.save", id: e.id, ...(d.key ? { key: d.key } : {}), ...(d.region ? { region: d.region } : {}), ...(d.base !== undefined ? { base: d.base } : {}), ...(Object.keys(d.fields).length ? { fields: d.fields } : {}) });
  if (typeof got === "string") { k.note = [got]; return { kind: "refused" }; }
  k.note = [`${e.name} key saved.`];
  return { kind: "saved", saved: got.items.find((x) => x.id === e.id) ?? { id: e.id, key: !!d.key } };
}

/** Asks the service which models it has, which also shows whether the address and the key are right. */
async function chooseModel(k: Kit, e: ProviderEntry): Promise<Result | "again"> {
  let model: string | undefined;
  if (e.adc) model = await k.text("Model", k.frame(e.name, "The name the service gives the model."));
  else {
    const asking = { heading: k.heading(e.name) };
    const asked = k.io.work
      ? await k.io.work(`Asking ${e.name} for its models`, asking, () => k.link.call("provider.models", { cmd: "provider.models", id: e.id }))
      : await k.link.call("provider.models", { cmd: "provider.models", id: e.id });
    if (asked === "back" || asked === undefined) return "again";
    if (typeof asked === "string") { k.note = [asked]; return "again"; }
    if (!asked.models.length) { k.note = [`${e.name} has no models to choose.`]; return "again"; }
    const picked = await k.choose("Which model?", e.name, asked.models.map((m) => ({ label: m })));
    model = picked === undefined ? undefined : asked.models[picked];
  }
  if (!model) return "again";
  k.switching(true);
  k.link.send({ cmd: "provider.use", id: e.id, model });
  return "switched";
}
