/** A scripted model that asks the person one question and then repeats what it was told. It keeps what it received, so a script can check what the MODEL got, not only what a page shows. */
export function startAskingModel() {
  /** The result of each question, as the model received it, in order. */
  const heard: string[] = [];
  const chunk = (delta: object, finish?: string): string => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }], usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 } })}\n\n`;
  const call = { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions: [{ question: "Which port?", choices: ["80", "8080"] }] }) } }] };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return Response.json({ data: [{ id: "mock-model" }] });
      const body = (await req.json()) as { messages: { role: string; content: unknown }[]; stream?: boolean; tools?: unknown[] };
      if (!body.stream || !body.tools?.length) return Response.json({ choices: [{ message: { content: "A port" } }] });
      // What the person asked last, past the engine's own bracketed reminders: a question is asked once for each of those.
      const asked = body.messages.findLastIndex((m) => m.role === "user" && !String(m.content).startsWith("["));
      const answered = body.messages.slice(asked + 1).findLast((m) => m.role === "tool");
      const result = answered ? String(answered.content) : undefined;
      if (result !== undefined && body.messages.at(-1) === answered) heard.push(result);
      const out = result !== undefined ? chunk({ content: `heard: ${result}` }) + chunk({}, "stop") : chunk(call) + chunk({}, "tool_calls");
      return new Response(`${out}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, heard, stop: () => { void server.stop(true); } };
}
