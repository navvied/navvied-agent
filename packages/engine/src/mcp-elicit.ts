/**
 * `elicitation/create`: a connected program asks the person for something, with a small form (text, number, yes/no, one or several of a list;
 * one level of nested object). Each field becomes one question of the existing question machinery. The answer is `accept` with the values,
 * `decline` (the person said no, or left a required field empty) or `cancel` (nobody could be asked, or nobody answered). A field that looks like a
 * secret is never filled in by the engine: not from a default, not from anything else; the person types it or the form is declined.
 */
import type { QuestionItem } from "@navvied/protocol";
import { INVALID, McpRequestError } from "./mcp-host.ts";

const MOST_FIELDS = 12;
const MOST_PER_TURN = 5;
const AT_ONCE = 4;
const AGAIN = 2;
const MESSAGE = 600;
const SECRET = /pass(word|wd|phrase|code)?\b|secret|token|api[-_ ]?key|credential|\bpin\b|private[-_ ]?key/i;

type Kind = "string" | "number" | "integer" | "boolean" | "choice" | "choices";
export interface Field {
  /** Where the value goes in the answer: the name, or the name of the object and the name inside it. */
  path: string[];
  label: string;
  description?: string;
  kind: Kind;
  /** For `choice` and `choices`: what the person sees and what is sent. */
  options?: { label: string; value: string }[];
  required: boolean;
  secret: boolean;
  default?: unknown;
  /** Why the person is asked again: what was wrong with the last answer. */
  note?: string;
  limits: { min?: number; max?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number };
}

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function optionsOf(schema: Record<string, unknown>): { label: string; value: string }[] | undefined {
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  if (Array.isArray(schema.enum)) return schema.enum.filter((v): v is string => typeof v === "string").map((value, i) => ({ value, label: typeof names[i] === "string" ? (names[i] as string) : value }));
  const one = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (one?.length && one.every((o) => typeof obj(o)?.const === "string")) return one.map((o) => ({ value: obj(o)!.const as string, label: typeof obj(o)!.title === "string" ? (obj(o)!.title as string) : (obj(o)!.const as string) }));
  return undefined;
}

function fieldOf(path: string[], schema: Record<string, unknown>, required: boolean): Field {
  const name = path.join(".");
  const title = typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : path[path.length - 1]!;
  const base = { path, label: title, ...(typeof schema.description === "string" && schema.description.trim() ? { description: schema.description.trim() } : {}), required, secret: SECRET.test(name) || SECRET.test(title) || schema.format === "password" || schema.writeOnly === true, limits: { min: num(schema.minimum), max: num(schema.maximum), minLength: num(schema.minLength), maxLength: num(schema.maxLength), minItems: num(schema.minItems), maxItems: num(schema.maxItems) }, ...(schema.default !== undefined ? { default: schema.default } : {}) };
  const options = optionsOf(schema);
  if (schema.type === "string") return { ...base, kind: options ? "choice" : "string", ...(options ? { options } : {}) };
  if (schema.type === "number" || schema.type === "integer") return { ...base, kind: schema.type };
  if (schema.type === "boolean") return { ...base, kind: "boolean" };
  const items = obj(schema.items);
  const many = schema.type === "array" && items ? optionsOf(items) : undefined;
  if (many) return { ...base, kind: "choices", options: many };
  throw new McpRequestError(INVALID, `the field "${name}" is not something a person can be asked for`);
}

/** The fields of a form schema, in order. A schema that is not flat or small enough is refused with the reason. */
export function fieldsOf(schema: unknown): Field[] {
  const top = obj(schema);
  const props = obj(top?.properties);
  if (!top || !props) return [];
  const needed = new Set(Array.isArray(top.required) ? top.required : []);
  const fields = Object.entries(props).flatMap(([key, raw]): Field[] => {
    const one = obj(raw);
    if (!one) throw new McpRequestError(INVALID, `the field "${key}" has no schema`);
    const inner = obj(one.properties);
    if (one.type !== "object" || !inner) return [fieldOf([key], one, needed.has(key))];
    const innerNeeded = new Set(Array.isArray(one.required) ? one.required : []);
    return Object.entries(inner).map(([k, v]) => { const f = obj(v); if (!f) throw new McpRequestError(INVALID, `the field "${key}.${k}" has no schema`); return fieldOf([key, k], f, needed.has(key) && innerNeeded.has(k)); });
  });
  if (fields.length > MOST_FIELDS) throw new McpRequestError(INVALID, `the form has more than ${MOST_FIELDS} fields`);
  return fields;
}

const YES = new Set(["yes", "y", "true", "1", "on"]);
const NO = new Set(["no", "n", "false", "0", "off"]);

/** The value a person's answer stands for, or why it does not fit. */
export function valueOf(f: Field, said: string[]): { value: unknown } | { problem: string } {
  const words = said.map((s) => s.trim()).filter(Boolean);
  const text = words.join(", ");
  const within = (n: number, what: string): string | undefined => (f.limits.min !== undefined && n < f.limits.min ? `${what} must be at least ${f.limits.min}` : f.limits.max !== undefined && n > f.limits.max ? `${what} must be at most ${f.limits.max}` : undefined);
  switch (f.kind) {
    case "string": {
      const bad = f.limits.minLength !== undefined && text.length < f.limits.minLength ? `at least ${f.limits.minLength} characters` : f.limits.maxLength !== undefined && text.length > f.limits.maxLength ? `at most ${f.limits.maxLength} characters` : undefined;
      return bad ? { problem: `${f.label} needs ${bad}` } : { value: text };
    }
    case "number": case "integer": {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.kind === "integer" && !Number.isInteger(n))) return { problem: `${f.label} needs ${f.kind === "integer" ? "a whole number" : "a number"}` };
      const bad = within(n, f.label);
      return bad ? { problem: bad } : { value: n };
    }
    case "boolean": {
      const w = text.toLowerCase();
      return YES.has(w) ? { value: true } : NO.has(w) ? { value: false } : { problem: `${f.label} needs yes or no` };
    }
    case "choice": case "choices": {
      const picked: string[] = [];
      for (const w of words) {
        const o = f.options!.find((x) => x.label.toLowerCase() === w.toLowerCase() || x.value.toLowerCase() === w.toLowerCase());
        if (!o) return { problem: `${f.label} needs one of: ${f.options!.map((x) => x.label).join(", ")}` };
        if (!picked.includes(o.value)) picked.push(o.value);
      }
      if (f.kind === "choice") return picked.length === 1 ? { value: picked[0] } : { problem: `${f.label} needs one of: ${f.options!.map((x) => x.label).join(", ")}` };
      const bad = f.limits.minItems !== undefined && picked.length < f.limits.minItems ? `at least ${f.limits.minItems} choices` : f.limits.maxItems !== undefined && picked.length > f.limits.maxItems ? `at most ${f.limits.maxItems} choices` : undefined;
      return bad ? { problem: `${f.label} needs ${bad}` } : { value: picked };
    }
  }
}

export interface ElicitDeps {
  /** Waits for the person's answers, one list per question; nothing when nobody answered (the window was closed, the turn stopped, no time). */
  ask(questions: QuestionItem[], signal: AbortSignal, server: string): Promise<string[][] | undefined>;
  attended(): boolean;
  /** The person typed this in a field that holds a secret: it is hidden from now on wherever it would be shown. */
  secret(value: string): void;
}

const questionOf = (f: Field, first?: string): QuestionItem => {
  const header = first ?? f.note;
  const text = `${f.label}${f.description ? ` (${f.description})` : ""}`;
  return { question: header ? `${header}\n${text}` : text, ...(f.kind === "boolean" ? { choices: ["Yes", "No"] } : f.options ? { choices: f.options.map((o) => o.label) } : {}), ...(f.kind === "choices" ? { multi: true as const } : {}) };
};

const place = (into: Record<string, unknown>, path: string[], value: unknown): void => {
  if (path.length === 1) { into[path[0]!] = value; return; }
  const inner = (into[path[0]!] ??= {}) as Record<string, unknown>;
  inner[path[1]!] = value;
};

export class Elicitor {
  readonly #count = new Map<string, number>();

  constructor(private readonly deps: ElicitDeps) {}

  newTurn(): void { this.#count.clear(); }

  async elicit(server: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (params.mode !== undefined && params.mode !== "form") throw new McpRequestError(INVALID, "only forms are supported");
    const fields = fieldsOf(obj(params.requestedSchema));
    const said = typeof params.message === "string" ? params.message.trim().slice(0, MESSAGE) : "";
    const header = `${server}${said ? `: ${said}` : ""}`;
    const none = { action: "cancel" };
    if (!this.deps.attended() || (this.#count.get(server) ?? 0) >= MOST_PER_TURN) return none;
    this.#count.set(server, (this.#count.get(server) ?? 0) + 1);

    if (!fields.length) {
      const [pick] = (await this.deps.ask([{ question: header, choices: ["Continue", "Decline"] }], signal, server)) ?? [];
      return pick === undefined ? none : pick[0]?.toLowerCase() === "continue" ? { action: "accept", content: {} } : { action: "decline" };
    }

    const content: Record<string, unknown> = {};
    let todo = fields, first = true;
    for (let round = 0; todo.length; round++) {
      if (round > AGAIN) return { action: "decline" };
      const retry: Field[] = [];
      for (let at = 0; at < todo.length; at += AT_ONCE) {
        const batch = todo.slice(at, at + AT_ONCE);
        const answers = await this.deps.ask(batch.map((f, i) => questionOf(f, first && i === 0 ? header : undefined)), signal, server);
        first = false;
        if (!answers) return none;
        for (const [i, f] of batch.entries()) {
          const given = answers[i] ?? [];
          if (!given.some((g) => g.trim())) {
            if (f.default !== undefined && !f.secret) place(content, f.path, f.default);
            else if (f.required) return { action: "decline" };
            continue;
          }
          const got = valueOf(f, given);
          if ("problem" in got) { retry.push({ ...f, note: `${got.problem}.` }); continue; }
          if (f.secret) for (const g of given) this.deps.secret(g.trim());
          place(content, f.path, got.value);
        }
      }
      todo = retry;
    }
    return { action: "accept", content };
  }
}
