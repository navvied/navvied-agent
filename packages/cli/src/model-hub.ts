import { fitOf, type Fit } from "./fit.ts";
import { readShape, type ModelShape } from "./gguf.ts";
import type { Machine } from "./machine.ts";

/** The place models are searched and fetched from (its address is data of presets.ts). */
export interface Hub { base: string }

/** One file a person can choose, or the first of the parts that make one model. */
export interface HubFile {
  repo: string;
  file: string;
  quant: string;
  sizeBytes: number;
  /** Every part of a model that comes in several files, in order (this is the first); one entry for a model that is one file. */
  parts: { path: string; sizeBytes: number; sha256?: string }[];
  gated: boolean;
}

export interface Candidate extends HubFile { fit?: Fit["fit"]; needMb?: number; gpuLayers?: number; contextLength?: number }

type Error1 = { error: string; retryAfterSeconds?: number };

const QUANT = /(?:^|[-_.])((?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|FP16|F16|FP32|F32|MXFP4))(?=[-_.]|$)/i;
const PART = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** What the hub says about how many requests are left in a window: `RateLimit: "api";r=498;t=83` (the kind of request, how many are left, seconds to the reset). */
export function rateOf(res: Response): { kind: string; remaining: number; resetSeconds: number } | undefined {
  const h = res.headers.get("ratelimit") ?? "";
  const m = /^"?([a-z]+)"?\s*;\s*r=(\d+)(?:\s*;\s*t=(\d+))?/i.exec(h);
  return m ? { kind: m[1]!, remaining: Number(m[2]), resetSeconds: m[3] ? Number(m[3]) : 300 } : undefined;
}

/** How many questions of each kind are left in the hub's window, as its last answers said (shared by the questions of one search). */
export type Allowance = Map<string, { remaining: number; resetSeconds: number }>;

const headers = (token?: string, extra: Record<string, string> = {}): Record<string, string> => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });

async function ask(fetchFn: typeof fetch, url: string, token: string | undefined, extra: Record<string, string> = {}, allowance?: Allowance): Promise<Response | Error1> {
  try {
    const res = await fetchFn(url, { headers: headers(token, extra), signal: AbortSignal.timeout(15_000) });
    const rate = rateOf(res);
    if (rate && allowance) allowance.set(rate.kind, rate);
    if (res.status === 429) { const wait = Number(res.headers.get("retry-after")) || rateOf(res)?.resetSeconds || 60; return { error: `The model hub asked to wait ${wait} seconds before more questions.`, retryAfterSeconds: wait }; }
    return res;
  } catch { return { error: "The model hub could not be reached." }; }
}

/** The repositories of GGUF models that match the words, the most downloaded first. */
export async function searchRepos(fetchFn: typeof fetch, hub: Hub, query: string, token: string | undefined, limit = 12, allowance?: Allowance): Promise<{ repos: { id: string; gated: boolean; downloads: number }[] } | Error1> {
  const url = `${hub.base}/api/models?filter=gguf&search=${encodeURIComponent(query)}&sort=downloads&limit=${limit}&expand[]=gated&expand[]=downloads`;
  const res = await ask(fetchFn, url, token, {}, allowance);
  if ("error" in res) return res;
  if (!res.ok) return { error: `The model hub answered ${res.status}.` };
  const body = (await res.json().catch(() => [])) as { id?: unknown; gated?: unknown; downloads?: unknown }[];
  return { repos: body.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string, gated: m.gated === true || typeof m.gated === "string", downloads: typeof m.downloads === "number" ? m.downloads : 0 })) };
}

/** The GGUF files of a repository, the parts of a split model together, the vision projectors left out (they are not models). */
export async function listFiles(fetchFn: typeof fetch, hub: Hub, repo: string, gated: boolean, token: string | undefined, allowance?: Allowance): Promise<HubFile[] | Error1> {
  const res = await ask(fetchFn, `${hub.base}/api/models/${repo}/tree/main`, token, {}, allowance);
  if ("error" in res) return res;
  if (res.status === 401 || res.status === 403) return { error: "This model needs the licence accepted on its page, and a token." };
  if (!res.ok) return { error: `The model hub answered ${res.status}.` };
  const tree = (await res.json().catch(() => [])) as { type?: string; path?: string; size?: number; lfs?: { oid?: string; size?: number } }[];
  const files = tree.filter((f) => f.type === "file" && typeof f.path === "string" && /\.gguf$/i.test(f.path) && !/(^|\/)mmproj/i.test(f.path)).map((f) => ({ path: f.path!, sizeBytes: f.lfs?.size ?? f.size ?? 0, ...(f.lfs?.oid ? { sha256: f.lfs.oid } : {}) }));
  const whole = new Map<string, HubFile>();
  for (const f of files) {
    const part = PART.exec(f.path);
    const key = part ? part[1]! : f.path;
    const have = whole.get(key);
    if (have) { have.parts.push(f); have.sizeBytes += f.sizeBytes; continue; }
    const quant = (QUANT.exec(part ? part[1]! : f.path)?.[1] ?? "unknown").toUpperCase();
    whole.set(key, { repo, file: f.path, quant, sizeBytes: f.sizeBytes, parts: [f], gated });
  }
  for (const w of whole.values()) { w.parts.sort((a, b) => a.path.localeCompare(b.path)); w.file = w.parts[0]!.path; }
  return [...whole.values()].filter((w) => w.sizeBytes > 0 && (w.parts.length === 1 || PART.exec(w.parts[0]!.path)?.[2] === "00001")).sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/** The shape of the model of a file, from the start of the file only (a few hundred kilobytes, more if the header is longer). */
export async function readRemoteShape(fetchFn: typeof fetch, hub: Hub, repo: string, file: string, token: string | undefined, allowance?: Allowance): Promise<ModelShape | Error1> {
  for (const size of [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
    const res = await ask(fetchFn, `${hub.base}/${repo}/resolve/main/${file}`, token, { range: `bytes=0-${size - 1}` }, allowance);
    if ("error" in res) return res;
    if (res.status === 401 || res.status === 403) return { error: "This model needs the licence accepted on its page, and a token." };
    if (res.status !== 200 && res.status !== 206) return { error: `The model hub answered ${res.status}.` };
    const got = readShape(new Uint8Array(await res.arrayBuffer()));
    if ("shape" in got) return got.shape;
    if ("error" in got) return { error: got.error };
  }
  return { error: "The header of the file is longer than is read." };
}

/** The quants a person is best served by first: 4-bit and up, the middle ones before the extremes; full-precision files (the largest, the slowest) last among those that fit. */
const PREFERRED = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q4_K_S", "Q5_K_S", "Q8_0", "Q4_0", "Q3_K_L", "Q3_K_M"];
const quantRank = (q: string): number => { const at = PREFERRED.indexOf(q.toUpperCase()); return at >= 0 ? at : /^(F16|FP16|BF16|F32|FP32)$/i.test(q) ? 100 : 50; };

export interface Searched { items: Candidate[]; notes: string[] }

/**
 * Models that match, with where each runs on this computer at the context asked for (smaller than what the model supports when that is what is asked).
 * One question per repository for its files and one for the start of one file (the quants of a repository are one model), a few at a time; when the hub says the
 * window of questions is nearly used up, the rest is left and said so.
 */
export async function searchModels(fetchFn: typeof fetch, hub: Hub, input: { query: string; window: number; machine: Machine; token?: string; limit?: number }): Promise<Searched | Error1> {
  const allowance: Allowance = new Map();
  const found = await searchRepos(fetchFn, hub, input.query, input.token, input.limit, allowance);
  if ("error" in found) return found;
  const notes: string[] = [];
  const items: Candidate[] = [];
  const repos = found.repos.slice();
  const shapes = new Map<string, ModelShape | undefined>();
  for (let i = 0; i < repos.length; i += 4) {
    // A batch needs a question of each kind per repository; when the window has less than that left, the rest waits for the next one.
    const low = [...allowance.entries()].find(([, a]) => a.remaining < 8);
    if (low) { notes.push(`${repos.length - i} more were left out: the model hub allows only a few more questions for now (${low[1].resetSeconds} seconds to the next window).`); break; }
    await Promise.all(repos.slice(i, i + 4).map(async (r) => {
      const files = await listFiles(fetchFn, hub, r.id, r.gated, input.token, allowance);
      if ("error" in files) { notes.push(`${r.id}: ${files.error}`); return; }
      if (!files.length) return;
      const probe = files[0]!;
      const shape = await readRemoteShape(fetchFn, hub, r.id, probe.file, input.token, allowance);
      shapes.set(r.id, "error" in shape ? undefined : shape);
      if ("error" in shape && !r.gated) notes.push(`${r.id}: ${shape.error}`);
      for (const f of files) {
        const s = shapes.get(r.id);
        if (!s) { items.push({ ...f }); continue; }
        const window = Math.min(input.window, s.contextLength ?? input.window);
        const fit = fitOf(f.sizeBytes, s, window, input.machine);
        items.push(fit ? { ...f, fit: fit.fit, needMb: fit.needMb, gpuLayers: fit.gpuLayers, contextLength: window } : { ...f });
      }
    }));
  }
  // Equal files stay in the hub's own order (most downloaded first), never in the order the questions happened to be answered.
  const place = new Map(repos.map((r, n) => [r.id, n]));
  const rank = { gpu: 0, ram: 1, none: 3, undefined: 2 } as const;
  items.sort((a, b) => rank[a.fit ?? "undefined"] - rank[b.fit ?? "undefined"] || quantRank(a.quant) - quantRank(b.quant) || b.sizeBytes - a.sizeBytes || place.get(a.repo)! - place.get(b.repo)!);
  return { items, notes };
}
