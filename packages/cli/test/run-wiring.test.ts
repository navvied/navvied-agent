import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAccount } from "../src/account.ts";
import { accountPath, configPath, hostedModelsPath, sessionsDir } from "../src/config.ts";
import { main } from "../src/main.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

/** What the scripted model does with one request: what it says, or the tool calls it makes. */
type Reply = { text?: string; calls?: { name: string; args: unknown }[]; delayMs?: number };
interface Seen { tools: string[]; last: string; role: string }

const dirs: string[] = [];
let script: (seen: Seen) => Reply = () => ({ text: "ok" });
let asked = 0, listings = 0;
let server: ReturnType<typeof Bun.serve>;
const listing = { default: "pulse", data: [{ id: "pulse", name: "Pulse", api: "chat", window: 100_000, reasoning: "none" }] };

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") { listings++; return Response.json(listing); }
    if (req.method !== "POST") return new Response("", { status: 404 });
    const body = (await req.json()) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
    const last = body.messages.at(-1)!;
    const reply = script({ tools: (body.tools ?? []).map((t) => t.function.name), last: String(last.content ?? ""), role: last.role });
    if (reply.delayMs) await Bun.sleep(reply.delayMs);
    const n = asked++;
    const chunk = (delta: object, finish?: string): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }], usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } })}\n\n`;
    const calls = (reply.calls ?? []).map((c, index) => ({ index, id: `call_${n}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    const text = (reply.text ? chunk({ content: reply.text }) : "") + (calls.length ? chunk({ tool_calls: calls }) + chunk({}, "tool_calls") : chunk({}, "stop")) + "data: [DONE]\n\n";
    return new Response(text, { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => { server.stop(true); dirs.forEach(remove); });

/** A computer of its own: `navvied run` is the real command, the model is the scripted server. */
function computer(o: { signedIn?: boolean } = {}) {
  const home = tempDir(), work = tempDir();
  dirs.push(home, work);
  const env: Record<string, string> = { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_WINDOW: "100000", ...(o.signedIn ? {} : { NAVVIED_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NAVVIED_MODEL: "m" }) };
  if (o.signedIn) { mkdirSync(dirname(configPath(env)), { recursive: true }); writeAccount(accountPath(env), { server: `http://127.0.0.1:${server.port}`, token: "t-secret", email: "me@example.com" }); }
  const run = async (...args: string[]) => {
    const f = fakeIO({ env });
    const code = await main(["run", ...args, "--cwd", work], f.io);
    return { code, out: f.out(), err: f.err() };
  };
  return { env, run };
}

describe("navvied run, with the same wiring as every front-end", () => {
  test("a background helper's answer is waited for and comes into the answer", async () => {
    script = (s) => {
      if (!s.tools.includes("Agent")) return { text: "HELPER-RESULT-42", delayMs: 150 };
      if (s.last.startsWith("[Helper")) return { text: `The helper said: ${s.last.split("\n")[1]}` };
      if (s.role === "tool") return { text: "I started it." };
      return { calls: [{ name: "Agent", args: { description: "look", prompt: "Find the number.", background: true } }] };
    };
    const r = await computer().run("find the number with a helper in the background", "--last");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("The helper said: HELPER-RESULT-42");
  });

  test("Recall lists the earlier conversations of run, and never the one being had", async () => {
    const c = computer();
    script = () => ({ text: "Noted." });
    expect((await c.run("the code word is PELICAN-STRIPE", "--last")).code).toBe(0);
    let found = "";
    const recalling = (args: object) => (s: Seen): Reply => {
      if (s.role === "tool") { found = s.last; return { text: "done" }; }
      return { calls: [{ name: "Recall", args }] };
    };
    script = recalling({});
    expect((await c.run("what did we talk about before", "--last")).code).toBe(0);
    expect(found).toContain("the code word is PELICAN-STRIPE");
    expect(found).not.toContain("what did we talk about before");
    expect(readdirSync(sessionsDir(c.env)).length).toBe(2);
    script = recalling({ query: "talk about" });
    expect((await c.run("search again", "--last")).code).toBe(0);
    expect(found).toContain("what did we talk about before");
    expect(found).not.toContain("search again");
  });

  test("a signed-in computer that never listed the hosted models fetches them, so a hosted model can be named", async () => {
    listings = 0;
    script = () => ({ text: "from the hosted model" });
    const c = computer({ signedIn: true });
    const r = await c.run("hello", "-m", "navvied-pulse", "--last");
    expect(r.err).toBe("");
    expect(r.out.trim()).toBe("from the hosted model");
    expect(r.code).toBe(0);
    expect(listings).toBe(1);
    expect(await Bun.file(hostedModelsPath(c.env)).exists()).toBe(true);
  });
});
