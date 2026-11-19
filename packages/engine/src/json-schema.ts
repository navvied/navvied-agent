/**
 * A check of a value against a JSON Schema, for the parts people use to describe the answer they want: types, properties, required,
 * additionalProperties, items, enum, const, bounds, lengths, patterns and anyOf. It says what is wrong in words a model can fix.
 * Parts it does not know are not checked (never refused).
 */
type Schema = Record<string, unknown>;

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v: unknown, t: string): boolean => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : kind(v) === t);

export function validate(value: unknown, schema: unknown, path = "$"): string[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  const s = schema as Schema;
  const errors: string[] = [];
  const here = (message: string): void => { errors.push(`${path}: ${message}`); };

  if (Array.isArray(s.anyOf)) {
    const tries = s.anyOf.map((sub) => validate(value, sub, path));
    if (!tries.some((e) => e.length === 0)) here(`does not match any of the allowed shapes (${tries.map((e) => e[0] ?? "").filter(Boolean).slice(0, 2).join("; ")})`);
  }
  if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) here(`must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) here(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === "string") : [];
  if (types.length && !types.some((t) => isType(value, t))) { here(`must be ${types.join(" or ")}, not ${kind(value)}`); return errors; }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) here(`must be at least ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) here(`must be at most ${s.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) here(`must have at least ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) here(`must have at most ${s.maxLength} characters`);
    if (typeof s.pattern === "string") { try { if (!new RegExp(s.pattern).test(value)) here(`must match ${s.pattern}`); } catch { /* a pattern we cannot read is not checked */ } }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) here(`must have at least ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) here(`must have at most ${s.maxItems} items`);
    if (s.items !== undefined) value.forEach((item, i) => errors.push(...validate(item, s.items, `${path}[${i}]`)));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = typeof s.properties === "object" && s.properties !== null ? (s.properties as Record<string, unknown>) : {};
    if (Array.isArray(s.required)) for (const key of s.required) if (typeof key === "string" && !(key in obj)) here(`is missing "${key}"`);
    for (const [key, sub] of Object.entries(props)) if (key in obj) errors.push(...validate(obj[key], sub, `${path}.${key}`));
    if (s.additionalProperties === false) for (const key of Object.keys(obj)) if (!(key in props)) here(`has "${key}", which is not allowed`);
  }
  return errors;
}

/** The JSON in a model's answer: the whole text, or the first fenced block, or the first {…} or […] in it. */
export function jsonIn(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim(), /(\{[\s\S]*\}|\[[\s\S]*\])/.exec(text)?.[1]];
  for (const c of candidates) { if (!c) continue; try { return { ok: true, value: JSON.parse(c) }; } catch { /* try the next */ } }
  return { ok: false, error: "the answer is not JSON" };
}
