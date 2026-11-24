import type { EndpointModel, EndpointSaved } from "@navvied/protocol";
import type { Choice } from "../io.ts";
import type { Kit, Result } from "./kit.ts";

type Api = EndpointSaved["api"];
export const API_STYLES: readonly { id: Api; label: string }[] = [
  { id: "chat", label: "Chat completions" },
  { id: "responses", label: "Responses" },
  { id: "messages", label: "Messages" },
  { id: "ollama", label: "Ollama" },
];
const styleLabel = (api: Api): string => API_STYLES.find((s) => s.id === api)?.label ?? api;

/** An endpoint as the form holds it: what the person is typing, before it is saved. `key` is only set when a new one was pasted (an empty one takes it away). */
export interface Draft { id?: string; name: string; baseUrl: string; api: Api; key?: string; keySaved: boolean; models: EndpointModel[] }

export const draftOf = (e?: EndpointSaved): Draft => e
  ? { id: e.id, name: e.name, baseUrl: e.baseUrl, api: e.api, keySaved: e.key, models: e.models.map((m) => ({ ...m })) }
  : { name: "", baseUrl: "", api: "chat", keySaved: false, models: [] };

export function endpointRows(items: readonly EndpointSaved[]): Choice[] {
  return [...items.map((e) => ({ label: e.name, hint: e.baseUrl })), { label: "Add endpoint" }];
}

type Row = Choice & { act: "name" | "url" | "api" | "key" | "find" | "add" | "remove" | "save" | { model: number } };

const modelHint = (m: EndpointModel): { hint?: string } => { const hint = [m.window ? `Context window ${m.window}` : "", m.vision ? "Sees images" : "", m.pdf ? "Reads PDF files" : ""].filter(Boolean).join(". "); return hint ? { hint } : {}; };

/** The rows of the form: the settings, the models, then what can be done. */
export function formRows(d: Draft): Row[] {
  const hasKey = d.key === undefined ? d.keySaved : d.key !== "";
  const rows: Row[] = [
    { label: "Name", hint: d.name || "my-server", act: "name" },
    { label: "Endpoint URL", hint: d.baseUrl || "http://localhost:8080/v1", act: "url" },
    { label: "API style", hint: styleLabel(d.api), act: "api" },
    { label: "API key", hint: hasKey ? "Saved" : "Optional", act: "key" },
  ];
  d.models.forEach((m, i) => rows.push({ label: m.id || "New model", ...modelHint(m), act: { model: i } }));
  rows.push({ label: "Find models", act: "find" }, { label: "Add model", act: "add" });
  if (d.id) rows.push({ label: "Remove endpoint", act: "remove" });
  rows.push({ label: "Save", act: "save" });
  return rows;
}

/** Custom Endpoints: servers of the person's own, each with its address, how it is spoken, a key and the models to use. */
export async function endpointsScreen(k: Kit): Promise<Result> {
  let at = 0;
  for (;;) {
    const got = await k.link.call("endpoints", { cmd: "endpoints" });
    if (typeof got === "string") { k.note = [got]; return "back"; }
    const rows = endpointRows(got.items);
    const picked = await k.choose("Custom Endpoints", "Custom Endpoints", rows, { at });
    if (picked === undefined) return "back";
    at = picked;
    const next = await form(k, draftOf(got.items[picked]));
    if (next === "switched") return next;
  }
}

async function form(k: Kit, d: Draft): Promise<Result | "again"> {
  let at = 0;
  const original = { baseUrl: d.baseUrl, api: d.api };
  for (;;) {
    const rows = formRows(d);
    const picked = await k.choose(d.id ? d.name : "New endpoint", "Custom Endpoints", rows, { at });
    if (picked === undefined) return "again";
    at = picked;
    const act = rows[picked]!.act;
    if (act === "name") d.name = (await k.text("Name", k.frame("Custom Endpoints", "my-server"), d.name)) ?? d.name;
    else if (act === "url") d.baseUrl = (await k.text("Endpoint URL", k.frame("Custom Endpoints", "http://localhost:8080/v1"), d.baseUrl)) ?? d.baseUrl;
    else if (act === "api") { const s = await k.choose("API style", "Custom Endpoints", API_STYLES.map((x) => ({ label: x.label })), { at: API_STYLES.findIndex((x) => x.id === d.api) }); if (s !== undefined) d.api = API_STYLES[s]!.id; }
    else if (act === "key") { const key = await k.secret("API key", k.frame("Custom Endpoints", "Optional")); if (key) d.key = key; }
    else if (act === "find") await find(k, d, original);
    else if (act === "add") { d.models.push({ id: "" }); const i = d.models.length - 1; const r = await model(k, d, i); if (r === "removed" || !d.models[i]!.id) d.models.splice(i, 1); }
    else if (act === "remove") { if (await remove(k, d)) return "again"; }
    else if (act === "save") { if (await save(k, d)) return "again"; }
    else { const m = await model(k, d, act.model); if (m === "removed") d.models.splice(act.model, 1); }
  }
}

/** Asks the server which models it has; picking one adds it. A server that is saved and unchanged is asked by its id, so its saved key is used. */
async function find(k: Kit, d: Draft, original: { baseUrl: string; api: Api }): Promise<void> {
  const unchanged = d.id && d.baseUrl === original.baseUrl && d.api === original.api && d.key === undefined;
  const got = await k.link.call("endpoint.models", unchanged ? { cmd: "endpoint.models", id: d.id } : { cmd: "endpoint.models", baseUrl: d.baseUrl, api: d.api, ...(d.key ? { key: d.key } : {}) });
  if (typeof got === "string") { k.note = [got]; return; }
  d.api = got.api;
  const free = got.items.filter((m) => !d.models.some((x) => x.id === m.id));
  if (!free.length) { k.note = [got.items.length ? "Every model it has is already added." : "The server has no models."]; return; }
  k.note = [`The endpoint answered. ${got.items.length} model${got.items.length === 1 ? "" : "s"} found.`];
  const picked = await k.choose("Which model?", "Custom Endpoints", free.map((m) => ({ label: m.id, ...(m.window ? { hint: `Context window ${m.window}` } : {}) })));
  const m = picked === undefined ? undefined : free[picked];
  if (m) d.models.push({ id: m.id, ...(m.window ? { window: m.window } : {}) });
}

/** One model: its name as the server has it, its context window, and whether it sees images and reads PDF files. */
async function model(k: Kit, d: Draft, index: number): Promise<"kept" | "removed"> {
  const m = d.models[index]!;
  let at = 0;
  for (;;) {
    const rows: (Choice & { act: string })[] = [
      { label: "Model", hint: m.id || "my-model", act: "id" },
      { label: "Context window", hint: m.window ? String(m.window) : "32768", act: "window" },
      { label: "Sees images", hint: m.vision ? "On" : "Off", act: "vision" },
      { label: "Reads PDF files", hint: m.pdf ? "On" : "Off", act: "pdf" },
      { label: "Remove model", act: "remove" },
    ];
    const picked = await k.choose(m.id || "New model", "Custom Endpoints", rows, { at });
    if (picked === undefined) return "kept";
    at = picked;
    const act = rows[picked]!.act;
    if (act === "id") m.id = (await k.text("Model", k.frame("Custom Endpoints", "my-model"), m.id)) ?? m.id;
    else if (act === "window") {
      const text = await k.text("Context window", k.frame("Custom Endpoints", "32768"), m.window ? String(m.window) : "");
      if (text === undefined) continue;
      const n = Number(text);
      if (Number.isInteger(n) && n > 0) m.window = n; else delete m.window;
    }
    else if (act === "vision") m.vision = !m.vision;
    else if (act === "pdf") m.pdf = !m.pdf;
    else return "removed";
  }
}

async function remove(k: Kit, d: Draft): Promise<boolean> {
  const got = await k.link.call("endpoints", { cmd: "endpoint.remove", id: d.id });
  k.note = [typeof got === "string" ? got : "Removed."];
  return typeof got !== "string";
}

async function save(k: Kit, d: Draft): Promise<boolean> {
  const got = await k.link.call("endpoints", { cmd: "endpoint.save", ...(d.id ? { id: d.id } : {}), name: d.name, baseUrl: d.baseUrl, api: d.api, ...(d.key !== undefined ? { key: d.key } : {}), models: d.models });
  k.note = [typeof got === "string" ? got : "Saved."];
  return typeof got !== "string";
}
