const holds = (v: unknown, want: string): boolean => (typeof v === "string" ? v.toLowerCase().includes(want) : v && typeof v === "object" ? Object.values(v).some((x) => holds(x, want)) : false);

/** Looks through whatever structure a driver answered with for the first object that has a numeric field `key` and, anywhere inside it, a string that contains `needle`. For a check that reads an answer whose exact shape is not known beforehand. */
export function findNumber(data: unknown, key: string, needle: string): number | undefined {
  const want = needle.toLowerCase();
  const walk = (v: unknown): number | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const r = walk(x); if (r !== undefined) return r; } return undefined; }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o[key] === "number" && holds(o, want)) return o[key] as number;
      for (const x of Object.values(o)) { const r = walk(x); if (r !== undefined) return r; }
    }
    return undefined;
  };
  return walk(data);
}

/** The first number under `key` anywhere in the data. */
export function firstNumber(data: unknown, key: string): number | undefined {
  if (Array.isArray(data)) { for (const x of data) { const r = firstNumber(x, key); if (r !== undefined) return r; } return undefined; }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o[key] === "number") return o[key] as number;
    for (const x of Object.values(o)) { const r = firstNumber(x, key); if (r !== undefined) return r; }
  }
  return undefined;
}
