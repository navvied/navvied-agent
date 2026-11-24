import type { EngineEvent, LocalFile, MachineInfo } from "@navvied/protocol";
import type { Choice } from "../io.ts";
import type { Kit, Live, Result } from "./kit.ts";

type RuntimeEvent = Extract<EngineEvent, { ev: "local.runtime" }>;
type OllamaEvent = Extract<EngineEvent, { ev: "local.ollama" }>;
type OllamaPull = Extract<EngineEvent, { ev: "local.ollama.model" }>;
type FileEvent = Extract<EngineEvent, { ev: "local.file" }>;
type Installed = Extract<EngineEvent, { ev: "local.installed" }>["items"][number];

/** A model file on this computer or being fetched, as the screens show it. */
export interface Held { repo: string; file: string; quant: string; sizeMb: number; state: Installed["state"]; bytes?: number; total?: number; error?: string }

/** A model the person can act on: one the hub offered (a search, or the short list to start with), or one that is here. */
export interface Item { f: Pick<LocalFile, "repo" | "file" | "quant" | "sizeMb" | "gated"> & Partial<LocalFile> }

const keyOf = (repo: string, file: string): string => `${repo}\n${file}`;

/** What the hub has said about this computer's models so far: kept from events, read by the screens as they redraw. */
export class LocalState {
  runtime?: RuntimeEvent;
  machine?: MachineInfo;
  server?: Extract<EngineEvent, { ev: "local.server" }>;
  held = new Map<string, Held>();
  ollama?: OllamaEvent;
  /** The model Ollama is fetching now, while it is. */
  pulling?: OllamaPull;
  /** The name of the model to fetch, as typed. */
  ollamaName = "";
  /** What the list shows: a search, or the short list to start with. `notes` is what the hub says about it. */
  found: { items: LocalFile[]; notes: string[]; query: string } = { items: [], notes: [], query: "" };
  #known = new Map<string, { quant: string; sizeMb: number }>();

  remember(items: readonly LocalFile[]): void { for (const f of items) this.#known.set(keyOf(f.repo, f.file), { quant: f.quant, sizeMb: f.sizeMb }); }

  feed(e: EngineEvent): void {
    if (e.ev === "machine") this.machine = e;
    else if (e.ev === "local.runtime") this.runtime = e;
    else if (e.ev === "local.server") this.server = e;
    else if (e.ev === "local.ollama") this.ollama = e;
    else if (e.ev === "local.ollama.model") this.pulling = e.state === "downloading" || e.state === "verifying" ? e : undefined;
    else if (e.ev === "local.installed") {
      this.held.clear();
      for (const i of e.items) this.held.set(keyOf(i.repo, i.file), { ...i });
    } else if (e.ev === "local.file") this.#file(e);
  }

  #file(e: FileEvent): void {
    const key = keyOf(e.repo, e.file);
    if (e.state === "idle") { this.held.delete(key); return; }
    const was = this.held.get(key);
    const base = { repo: e.repo, file: e.file, quant: was?.quant ?? this.#known.get(key)?.quant ?? "", sizeMb: was?.sizeMb ?? this.#known.get(key)?.sizeMb ?? 0 };
    this.held.set(key, { ...base, state: e.state, ...(e.bytes !== undefined ? { bytes: e.bytes } : {}), ...(e.total !== undefined ? { total: e.total } : {}), ...(e.error ? { error: e.error } : {}) });
  }

  get(repo: string, file: string): Held | undefined { return this.held.get(keyOf(repo, file)); }

  /** A model is running when the hub says so for its file, or its server runs. */
  running(h: Held): boolean {
    return h.state === "running" || (this.server?.state === "running" && this.server.repo === h.repo && this.server.file === h.file);
  }
}

export const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;
const mbOf = (bytes = 0): number => Math.round(bytes / 1e6);
export const amount = (bytes: number, total: number): string => `${(bytes / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`;

export const FIT_WORDS = { gpu: "Fits your GPU", ram: "Uses system RAM", none: "Too big for this machine" } as const;

/** What this computer is, as lines of a key and its value. What could not be read is said so, never guessed. */
export function machineLines(m: MachineInfo | undefined): string[] {
  if (!m) return ["This machine", "Memory could not be read."];
  const gpu = m.gpus[0];
  const rows: [string, string][] = [];
  if (!gpu) rows.push(["Graphics card", "None"]);
  else if (gpu.kind !== "unified") rows.push(["GPU memory", gpu.memoryMb ? gb(gpu.memoryMb) : "Unknown"]);
  rows.push(["RAM", gb(m.ramMb)]);
  if (gpu?.kind === "unified") rows.push(["Memory", "Unified"]);
  if (m.disk) rows.push(["Free disk", gb(m.disk.freeMb)]);
  const width = Math.max(...rows.map(([key]) => key.length));
  return ["This machine", ...rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`)];
}

type Act = "install" | "cancel-runtime" | "stop-server" | "remove-runtime" | "none" | "search" | "ollama-name" | "ollama-pull" | "ollama-cancel" | { open: Item };
type Row = Choice & { act: Act };

/** The models in the list: what the hub offered, then what is here and was not offered. A search shows only what it found. */
export function items(s: LocalState): Item[] {
  const offered: Item[] = s.found.items.map((f) => ({ f }));
  if (s.found.query) return offered;
  const seen = new Set(offered.map((i) => keyOf(i.f.repo, i.f.file)));
  const here = [...s.held.values()].filter((h) => !seen.has(keyOf(h.repo, h.file))).sort((a, b) => a.repo.localeCompare(b.repo, undefined, { numeric: true })).map((h) => ({ f: { repo: h.repo, file: h.file, quant: h.quant, sizeMb: h.sizeMb, gated: false } }));
  return [...offered, ...here];
}

export function localRows(s: LocalState): Row[] {
  const r = s.runtime;
  const rows: Row[] = [];
  if (!r) rows.push({ label: "Local runtime", hint: "…", act: "none" });
  else if (r.state === "installing") rows.push({ label: "Cancel", hint: `Downloading ${mbOf(r.bytes)} of ${mbOf(r.total)} MB`, act: "cancel-runtime" });
  else if (r.state === "verifying") rows.push({ label: "Checking the download", act: "none" });
  else if (r.state === "failed") rows.push({ label: "Try again", hint: r.error ?? "The download failed.", act: "install" });
  else if (r.state === "none") rows.push({ label: "Install runtime", hint: `llama.cpp ${r.version}`, act: "install" });
  else {
    rows.push({ label: `llama.cpp ${r.version}`, hint: r.server === "running" ? "Running" : "Stopped", act: "none" });
    if (r.server === "running") rows.push({ label: "Stop server", act: "stop-server" });
    rows.push({ label: "Remove runtime", act: "remove-runtime" });
  }
  rows.push(...ollamaRows(s));
  rows.push({ label: "Search Hugging Face", act: "search" });
  for (const item of items(s)) {
    const h = s.get(item.f.repo, item.f.file);
    const words = h ? stateWords(s, h) : [item.f.fit ? FIT_WORDS[item.f.fit] : "", item.f.gated ? "Needs your token" : gb(item.f.sizeMb)].filter(Boolean).join(". ");
    rows.push({ label: `${item.f.repo}  ${item.f.quant}`, ...(words ? { hint: words } : {}), act: { open: item } });
  }
  return rows;
}

const OLLAMA_URL = "https://ollama.com/download";
const OLLAMA_EXAMPLE = "qwen3:14b";

/** Ollama on this computer: not installed (and where to get it), or ready with its models, a name to fetch one by, and the fetch while it goes. */
export function ollamaRows(s: LocalState): Row[] {
  const o = s.ollama;
  if (!o) return [];
  if (o.state === "missing") return [{ label: "Get Ollama", hint: `Not installed. ${OLLAMA_URL}`, act: "none" }];
  const rows: Row[] = [{ label: `Ollama ${o.version ?? ""}`.trim(), hint: "Ready", act: "none" }];
  for (const m of o.models ?? []) rows.push({ label: m.name, ...(m.tools === false ? { hint: "No tools" } : {}), act: "none" });
  const p = s.pulling;
  if (p) rows.push({ label: "Cancel", hint: `${p.model}  ${p.total ? `${Math.round(((p.bytes ?? 0) / p.total) * 100)}%` : ""}`.trim(), act: "ollama-cancel" });
  else rows.push({ label: "Model name", hint: s.ollamaName || OLLAMA_EXAMPLE, act: "ollama-name" }, { label: "Download", act: "ollama-pull" });
  return rows;
}

function stateWords(s: LocalState, h: Held): string {
  if (s.running(h)) return "Running";
  const of = h.total ? amount(h.bytes ?? 0, h.total) : gb(h.sizeMb);
  if (h.state === "downloading") return of;
  if (h.state === "paused") return `${of}, paused`;
  if (h.state === "nodisk") return h.error ?? "Not enough free disk space.";
  if (h.state === "failed") return h.error ?? "The download failed.";
  return gb(h.sizeMb);
}

const bar = (p: number): string => { const n = Math.round(Math.min(1, Math.max(0, p)) * 24); return `${"█".repeat(n)}${"░".repeat(24 - n)}  ${Math.round(p * 100)}%`; };

/** Local Models: the runtime, this machine, a search of the model hub with a fit for each file, downloads that pause and resume, and running one. */
export async function localScreen(k: Kit): Promise<Result> {
  const s = new LocalState();
  const off = k.link.watch((e) => s.feed(e));
  try {
    for (const [ev, cmd] of [["machine", { cmd: "machine" }], ["local.runtime", { cmd: "local.runtime" }], ["local.installed", { cmd: "local.models" }]] as const) {
      const got = await k.link.call(ev, cmd);
      if (typeof got === "string") { k.note = [got]; return "back"; }
    }
    await k.link.call("local.ollama", { cmd: "local.ollama" });
    await offer(k, s, "");
    let at = 0;
    for (;;) {
      let shown = localRows(s);
      const body = (): string[] => [...machineLines(s.machine), ...s.found.notes];
      const live = (): Live => { shown = localRows(s); return { rows: shown, body: body() }; };
      const picked = await k.choose("Local Models", "Local Models", shown, { at, body: body(), live });
      if (picked === undefined) return "back";
      at = picked;
      const act = shown[picked]?.act;
      if (act === "install") await said(k, s, "local.runtime", { cmd: "local.runtime.install" });
      else if (act === "cancel-runtime") await said(k, s, "local.runtime", { cmd: "local.runtime.cancel" });
      else if (act === "remove-runtime") await said(k, s, "local.runtime", { cmd: "local.runtime.remove" });
      else if (act === "stop-server") await said(k, s, "local.server", { cmd: "local.stop" });
      else if (act === "search") await search(k, s);
      else if (act === "ollama-name") s.ollamaName = (await k.text("Model name", k.frame("Local Models", OLLAMA_EXAMPLE), s.ollamaName)) ?? s.ollamaName;
      else if (act === "ollama-pull") await ollamaPull(k, s);
      else if (act === "ollama-cancel") { const model = s.pulling?.model; if (model) await said(k, s, "local.ollama.model", { cmd: "local.ollama.cancel", model }); }
      else if (act && typeof act === "object") await modelScreen(k, s, act.open);
    }
  } finally { off(); }
}

export function resultRows(items_: readonly LocalFile[]): Choice[] {
  return items_.map((f) => ({ label: `${f.repo}  ${f.quant}`, hint: [f.fit ? FIT_WORDS[f.fit] : "", f.gated ? "Needs your token" : gb(f.sizeMb)].filter(Boolean).join(". ") }));
}

/** The short list to start with (nothing typed), or the search for `query`. What the hub says about it is kept with the list. */
async function offer(k: Kit, s: LocalState, query: string): Promise<void> {
  const got = query ? await k.link.call("local.found", { cmd: "local.search", query }) : await k.link.call("local.found", { cmd: "local.recommended" });
  if (typeof got === "string") { k.note = [got]; if (query) s.found = { items: [], notes: [], query }; return; }
  s.remember(got.items);
  s.found = { items: got.items, notes: got.notes ?? [], query };
  if (query && !got.items.length) k.note = ["No model found."];
}

async function search(k: Kit, s: LocalState): Promise<void> {
  const query = await k.text("Search Hugging Face", k.frame("Local Models"), s.found.query);
  if (query === undefined) return;
  if (k.io.work && query) await k.io.work("Searching Hugging Face", { heading: k.heading("Local Models") }, () => offer(k, s, query));
  else await offer(k, s, query);
}

type FileAct = "download" | "token" | "pause" | "resume" | "cancel" | "run" | "stop" | "remove";
type FileRow = Choice & { act: FileAct };

export function fileRows(s: LocalState, item: Item): FileRow[] {
  const h = s.get(item.f.repo, item.f.file);
  if (!h || h.state === "failed") return [item.f.gated ? { label: "Needs your token", act: "token" } : { label: `Download ${gb(item.f.sizeMb || h?.sizeMb || 0)}`, act: "download" }];
  if (s.running(h)) return [{ label: "Stop", act: "stop" }, { label: "Remove", act: "remove" }];
  if (h.state === "downloading") return [{ label: "Pause", act: "pause" }, { label: "Cancel", act: "cancel" }];
  if (h.state === "paused") return [{ label: "Resume", act: "resume" }, { label: "Cancel", act: "cancel" }];
  if (h.state === "nodisk") return [{ label: "Cancel", act: "cancel" }];
  return [{ label: "Run", act: "run" }, { label: "Remove", act: "remove" }];
}

function fileBody(s: LocalState, item: Item): string[] {
  const h = s.get(item.f.repo, item.f.file);
  const lines = [`${item.f.repo}  ${item.f.quant}`];
  if (!h) { if (item.f.fit) lines.push(`${FIT_WORDS[item.f.fit]}${item.f.needMb ? `, ${gb(item.f.needMb)} of memory` : ""}.`); return lines; }
  lines.push(stateWords(s, h));
  if (h.total && (h.state === "downloading" || h.state === "paused")) lines.push(bar((h.bytes ?? 0) / h.total));
  return lines;
}

/** One model: where it is (not here, downloading, paused, here, running) and what can be done with it. The list follows the file as it changes. */
async function modelScreen(k: Kit, s: LocalState, item: Item): Promise<void> {
  const { repo, file } = item.f;
  for (;;) {
    let shown = fileRows(s, item);
    const live = (): Live | undefined => { shown = fileRows(s, item); return { rows: shown, body: fileBody(s, item) }; };
    const picked = await k.choose(repo, "Local Models", shown, { body: fileBody(s, item), live });
    const act = picked === undefined ? undefined : shown[picked]?.act;
    if (!act) return;
    const target = { repo, file };
    if (act === "download") { if (!(await pull(k, s, item))) return; }
    else if (act === "token") { if (!(await token(k, s, item))) return; }
    else if (act === "pause") await said(k, s, "local.file", { cmd: "local.pause", ...target });
    else if (act === "resume") await said(k, s, "local.file", { cmd: "local.pull", ...target });
    else if (act === "cancel") { await said(k, s, "local.file", { cmd: "local.cancel", ...target }); return; }
    else if (act === "run") await said(k, s, "local.server", { cmd: "local.run", ...target });
    else if (act === "stop") await said(k, s, "local.server", { cmd: "local.stop" });
    else if (await k.confirm(`Remove ${repo} and its files?`, "Local Models", "Remove", "Keep")) { await said(k, s, "local.file", { cmd: "local.remove", ...target }); return; }
  }
}

/** Starts the download. Not enough disk, or any other refusal, is said where the person was; false when the model's screen should close. */
async function pull(k: Kit, s: LocalState, item: Item): Promise<boolean> {
  const got = await k.link.call("local.file", { cmd: "local.pull", repo: item.f.repo, file: item.f.file });
  if (typeof got === "string") { k.note = [got]; return false; }
  s.feed(got);
  if (got.state === "nodisk" || got.state === "failed") { k.note = [got.error ?? "The download could not start."]; return false; }
  return true;
}

/** A model that needs a licence: where to accept it, and the token, kept for the hub only. */
async function token(k: Kit, s: LocalState, item: Item): Promise<boolean> {
  const page = item.f.page;
  const text = await k.secret("Hugging Face token", k.frame("Local Models", "Accept the licence on Hugging Face first.", ...(page ? [`Open the licence page: ${page}`] : []), "hf_..."));
  if (!text) return true;
  const saved = await k.link.call("providers", { cmd: "provider.save", id: "huggingface", key: text });
  if (typeof saved === "string") { k.note = [saved]; return true; }
  return pull(k, s, item);
}

/** Fetches the model named, through Ollama. Nothing typed, or a refusal, is said on the next screen. */
async function ollamaPull(k: Kit, s: LocalState): Promise<void> {
  const model = s.ollamaName.trim();
  if (!model) { const typed = await k.text("Model name", k.frame("Local Models", OLLAMA_EXAMPLE)); if (typed) s.ollamaName = typed; if (!typed) return; }
  const got = await k.link.call("local.ollama.model", { cmd: "local.ollama.pull", model: s.ollamaName.trim() });
  if (typeof got === "string") { k.note = [got]; return; }
  s.feed(got);
  if (got.state === "failed") k.note = [got.error ?? "The download failed."];
  else s.ollamaName = "";
}

/** A command whose answer is an event the state keeps; an error is said on the next screen. */
async function said(k: Kit, s: LocalState, ev: "local.file" | "local.server" | "local.runtime" | "local.ollama.model", cmd: object): Promise<void> {
  const got = await k.link.call(ev, cmd);
  if (typeof got === "string") k.note = [got];
  else s.feed(got);
}
