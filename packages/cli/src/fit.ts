import type { ModelShape } from "./gguf.ts";
import type { Machine } from "./machine.ts";

const MB = 1024 * 1024;

/**
 * What a model takes besides its weights, as rules of this program (no tool states them for every system, so they are stated here and tested):
 * the cache of keys and values (two bytes each, as llama.cpp keeps them by default), buffers of about 768 MB, and a tenth of what the memory has is left alone.
 * They err on the side of "does not fit": a model that is said to fit and does not is worse than one that is left out.
 */
export const OVERHEAD_MB = 768;

/**
 * The kinds of model the formula of the cache is proven for: attention in every layer, keys and values of the sizes the file says (a model with a window of
 * attention in some layers, such as the Gemma family, is counted as if every layer looked at everything, which is more than it takes, never less).
 * For any other kind (state-space, hybrid, one this list does not know) nothing is said of the fit: the answer is none, not "fits".
 */
export const PROVEN_ARCHITECTURES: readonly string[] = ["llama", "qwen2", "qwen3", "qwen3moe", "gemma2", "gemma3", "phi3"];
const HEADROOM = 0.9;
/** Apple silicon lets the card use about two thirds of the memory (the system's own limit is not read, so the smaller number is taken). */
const UNIFIED_SHARE = 0.66;
/** What is left to the system when the model runs in RAM. */
const SYSTEM_RAM_MB = 1024;

/** The cache of keys and values for `context` tokens, in MB. */
export function cacheMb(shape: ModelShape, context: number): number {
  let bytes = 0;
  for (let l = 0; l < shape.layers; l++) bytes += (shape.kvHeads[l] ?? shape.kvHeads[shape.kvHeads.length - 1] ?? 0) * (shape.keyLength + shape.valueLength) * context * 2;
  return bytes / MB;
}

/** The memory a person's computer can give a model: the cards that have memory of their own (their free memory now), and the RAM. */
export function budgetOf(m: Machine): { gpuMb: number; ramMb: number } {
  let gpuMb = 0;
  for (const g of m.gpus) {
    if (g.kind === "discrete") gpuMb += g.freeMb ?? g.memoryMb ?? 0;
    else if (g.kind === "unified") gpuMb += Math.floor(m.ramMb * UNIFIED_SHARE);
  }
  return { gpuMb: Math.floor(gpuMb * HEADROOM), ramMb: Math.max(0, Math.floor(((m.freeRamMb ?? Math.floor(m.ramMb / 2)) - SYSTEM_RAM_MB) * HEADROOM)) };
}

export interface Fit {
  /** `gpu`: all of it in the card's memory; `ram`: it needs the computer's memory (with as many layers on the card as there is room for); `none`: neither has room. */
  fit: "gpu" | "ram" | "none";
  needMb: number;
  /** For `ram`: how many layers the card takes (0 when it takes none). */
  gpuLayers: number;
}

/** Where a model of this many bytes, at this context, runs on this computer; undefined for a kind of model the formula is not proven for. */
export function fitOf(weightsBytes: number, shape: ModelShape, context: number, m: Machine): Fit | undefined {
  if (!PROVEN_ARCHITECTURES.includes(shape.architecture)) return undefined;
  const weights = weightsBytes / MB;
  const cache = cacheMb(shape, context);
  const need = weights + cache + OVERHEAD_MB;
  const { gpuMb, ramMb } = budgetOf(m);
  if (gpuMb > 0 && need <= gpuMb) return { fit: "gpu", needMb: Math.ceil(need), gpuLayers: shape.layers };
  const perLayer = (weights + cache) / shape.layers;
  const onCard = gpuMb > OVERHEAD_MB ? Math.min(shape.layers, Math.floor((gpuMb - OVERHEAD_MB) / perLayer)) : 0;
  const rest = need - onCard * perLayer;
  if (rest <= ramMb) return { fit: "ram", needMb: Math.ceil(need), gpuLayers: Math.max(0, onCard) };
  return { fit: "none", needMb: Math.ceil(need), gpuLayers: 0 };
}

const STEPS = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];

/** The largest context, among the usual sizes up to what the model supports, that fits where the weights run (a card first, else the RAM); undefined when not even the smallest does. */
export function largestContext(weightsBytes: number, shape: ModelShape, supported: number, m: Machine): number | undefined {
  let best: number | undefined;
  for (const c of STEPS) {
    if (c > supported) break;
    if (fitOf(weightsBytes, shape, c, m)?.fit !== "gpu" && fitOf(weightsBytes, shape, c, m)?.fit !== "ram") break;
    best = c;
  }
  return best;
}

/**
 * How a model is run here: the context, and how many layers go to the card. A model of a kind the formula is proven for gets the largest usual context that fits (or the one asked
 * for, if it fits) and the layers the fit says; any other kind runs on the processor alone with a modest context, because nothing is known of what it needs.
 */
export function planRun(weightsBytes: number, shape: ModelShape, m: Machine, asked?: number): { window: number; layers: number } | { error: string } {
  const supported = shape.contextLength ?? 32768;
  if (!PROVEN_ARCHITECTURES.includes(shape.architecture)) return { window: Math.min(asked ?? 8192, supported), layers: 0 };
  const window = asked ?? Math.min(32768, supported, largestContext(weightsBytes, shape, supported, m) ?? 0);
  if (!window) return { error: "This model does not fit in the memory this computer has free." };
  const fit = fitOf(weightsBytes, shape, Math.min(window, supported), m);
  if (!fit || fit.fit === "none") return { error: `This model does not fit in the memory this computer has free: it needs about ${fit?.needMb ?? 0} MB at a context of ${window}.` };
  return { window: Math.min(window, supported), layers: fit.fit === "gpu" ? 999 : fit.gpuLayers };
}
