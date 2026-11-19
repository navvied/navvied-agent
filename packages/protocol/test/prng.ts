/** A small seeded generator, so a failing random case can be reproduced from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;
export const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const int = (r: Rand, max: number): number => Math.floor(r() * max);

const WORDS = ["cmd", "ev", "text", "mode", "effort", "qid", "id", "images", "paths", "type", "subtype", "message", "content", "usage", "input", "output", "status", "name", "plan", "models", "model", "baseUrl", "command", "args", "window", "preview", "optionId", "mime", "data", "__proto__", "constructor", "", " "];
const STRINGS = ["", "prompt", "cancel", "approve", "restore", "ask", "auto", "plan", "high", "image/png", "x".repeat(300), "\u0000", "日本語", "\n", "{}", "null", "tool_use", "text_delta", "assistant", "user", "result", "success", "error", "-1", "1e9", "http://h/v1", "NaN"];

/** A random JSON-compatible value, biased toward the field names and values the program actually looks at. */
export function value(r: Rand, depth = 0): unknown {
  const kind = int(r, depth > 3 ? 6 : 9);
  switch (kind) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return Math.floor((r() - 0.5) * 2000);
    case 3: return (r() - 0.5) * 1e6;
    case 4: case 5: return pick(r, STRINGS);
    case 6: return Array.from({ length: int(r, 4) }, () => value(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = 0, n = int(r, 6); i < n; i++) o[pick(r, WORDS)] = value(r, depth + 1);
      return o;
    }
  }
}

export const garbage = (r: Rand): string => Array.from({ length: int(r, 80) }, () => String.fromCharCode(int(r, 0x2fff))).join("");

/** A valid-looking object with a few fields replaced or removed, so mutated inputs often land near the accepted shapes. */
export function mutate(r: Rand, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (let i = 0, n = 1 + int(r, 3); i < n; i++) {
    const keys = Object.keys(out);
    const key = keys.length && r() < 0.7 ? pick(r, keys) : pick(r, WORDS);
    if (r() < 0.3) delete out[key]; else out[key] = value(r, 2);
  }
  return out;
}
