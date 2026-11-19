import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonIn, validateJson } from "@navvied/engine";
import { main } from "../src/main.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const replies: string[] = [];
const seenPrompts: string[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as { messages: { role: string; content: unknown }[] };
    seenPrompts.push(String(body.messages.at(-1)?.content));
    const text = replies.shift() ?? "{}";
    const chunk = (delta: object, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }], usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } })}\n\n`;
    return new Response(chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => { server.stop(true); dirs.forEach(remove); });

const schema = { type: "object", properties: { title: { type: "string" }, count: { type: "integer", minimum: 0 } }, required: ["title", "count"], additionalProperties: false };

function run(args: string[]) {
  const dir = tempDir(); dirs.push(dir);
  const file = join(dir, "schema.json");
  writeFileSync(file, JSON.stringify(schema));
  const env = { HOME: dir, XDG_STATE_HOME: dir, NAVVIED_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000" };
  const f = fakeIO({ env });
  return main(["run", ...args.map((a) => a.replace("SCHEMA", file)), "--cwd", dir], f.io).then((code) => ({ code, out: f.out(), err: f.err() }));
}

describe("the schema checker", () => {
  test("types, required, extra properties, bounds, items, enums and anyOf say what is wrong", () => {
    expect(validateJson({ title: "x", count: 2 }, schema)).toEqual([]);
    expect(new Set(validateJson({ title: 5 }, schema))).toEqual(new Set(['$.title: must be string, not integer', '$: is missing "count"']));
    expect(new Set(validateJson({ title: "x", count: -1, extra: 1 }, schema))).toEqual(new Set(['$: has "extra", which is not allowed', "$.count: must be at least 0"]));
    expect(validateJson([1, "a"], { type: "array", items: { type: "integer" } })).toEqual(["$[1]: must be integer, not string"]);
    expect(validateJson("c", { enum: ["a", "b"] })).toEqual(['$: must be one of "a", "b"']);
    expect(validateJson(3, { anyOf: [{ type: "string" }, { type: "integer" }] })).toEqual([]);
    expect(validateJson(1, { somethingUnknown: true })).toEqual([]);
  });
  test("the JSON in an answer is found whole, in a fence, or inside other words", () => {
    expect(jsonIn('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(jsonIn('Here you go:\n```json\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
    expect(jsonIn('The result is {"a":3}. Done.')).toEqual({ ok: true, value: { a: 3 } });
    expect(jsonIn("no json here").ok).toBe(false);
  });
});

describe("navvied run --schema and --last", () => {
  test("a matching answer is printed alone, as one line of JSON", async () => {
    replies.push('```json\n{"title":"Hello","count":3}\n```');
    const r = await run(["make a title", "--schema", "SCHEMA"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('{"title":"Hello","count":3}\n');
    expect(seenPrompts.at(-1)).toContain("JSON Schema");
  });
  test("a wrong answer gets one chance to be put right, told exactly what was wrong", async () => {
    replies.push('{"title":"Hello"}', '{"title":"Hello","count":1}');
    const r = await run(["make a title", "--schema", "SCHEMA"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('{"title":"Hello","count":1}\n');
    expect(seenPrompts.at(-1)).toContain('is missing "count"');
  });
  test("an answer that is still wrong fails with the reasons, and prints nothing on standard output", async () => {
    replies.push("not json", "still not json");
    const r = await run(["make a title", "--schema", "SCHEMA"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("does not match the schema");
  });
  test("a schema file that cannot be read is a usage error, and --last prints only the final answer", async () => {
    const bad = await run(["x", "--schema", "/nonexistent/schema.json"]);
    expect(bad.code).toBe(2);
    replies.push("just the answer");
    const last = await run(["say it", "--last"]);
    expect(last.out).toBe("just the answer\n");
  });
});
