import type { Task } from "./task.ts";
import { repoFiles, solutionFiles } from "./task.ts";

/**
 * A scripted model that speaks the chat completions protocol, for trying the harness and the tasks without a real model.
 * `oracle` does what the task's reference solution does, through the agent's own tools: so a task is shown to be solvable by a real
 * agent run, not only by the validator. The others fail in one known way each, so every reason a run can fail is seen.
 */
export type Behaviour =
  | "oracle"  // writes the solution's files, runs its script, says it is done
  | "lazy"    // says it looked and changes nothing
  | "tamper"  // rewrites a protected file, then says it is done
  | "leave"   // does what the oracle does, then leaves a program running
  | "leak"    // says the key it was sent, and changes nothing
  | "crash"   // the model endpoint answers 500
  | "hang";   // never answers

export interface MockRequest { task: string; prompt: number; completion: number }

export interface Mock {
  /** What the `leave` behaviour starts and leaves running (unique to this mock, so it can be looked for by name). */
  leaves: string;
  /** The base address to give an agent: `…/v1`. */
  url: string;
  requests: MockRequest[];
  stop(): void;
}

const chars = (v: unknown): number => JSON.stringify(v).length;
const tokens = (n: number): number => Math.ceil(n / 4);

interface Step { tool: "Write" | "Bash"; args: Record<string, string> }

function stepsFor(task: Task, behaviour: Behaviour, leaves: string): Step[] {
  if (behaviour === "lazy" || behaviour === "leak" || behaviour === "crash" || behaviour === "hang") return [];
  if (behaviour === "tamper") {
    const protectedFile = Object.keys(repoFiles(task)).find((f) => task.protect.some((p) => new Bun.Glob(p).match(f)));
    return protectedFile ? [{ tool: "Write", args: { file_path: protectedFile, content: "// rewritten by the model\n" } }] : [];
  }
  const files = solutionFiles(task);
  const script = files["apply.sh"];
  delete files["apply.sh"];
  const steps: Step[] = Object.entries(files).map(([file_path, content]) => ({ tool: "Write", args: { file_path, content } }));
  if (script !== undefined) steps.push({ tool: "Bash", args: { command: script, description: "apply the solution" } });
  if (behaviour === "leave") steps.push({ tool: "Bash", args: { command: `(${leaves} >/dev/null 2>&1 &)`, description: "leave something running" } });
  return steps;
}

export function startMock(tasks: readonly Task[], behaviour: Behaviour | ((task: Task) => Behaviour) = "oracle"): Mock {
  const requests: MockRequest[] = [];
  const leaves = `sleep ${(50 + Math.random()).toFixed(6)}`;
  const encoder = new TextEncoder();
  const sse = (chunks: unknown[]): Response => new Response(new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(encoder.encode("data: [DONE]\n\n")); c.close(); },
  }), { headers: { "content-type": "text/event-stream" } });

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean; messages: { role: string; content: unknown }[] };
      const messages = body.messages;
      // Prompts are shared between tasks, but the workspace is named after its task and the agent says where it works.
      const seen = JSON.stringify(messages.slice(0, 2));
      const task = tasks.find((t) => seen.includes(`navvied-eval-${t.id}-`));
      const how = task ? (typeof behaviour === "function" ? behaviour(task) : behaviour) : "lazy";
      const promptTokens = tokens(chars(body));
      if (!body.stream) return Response.json({ choices: [{ message: { content: "SUMMARY" } }], usage: { prompt_tokens: promptTokens, completion_tokens: 1 } });
      if (how === "crash") return new Response("model is down", { status: 500 });
      if (how === "hang") return new Promise<Response>(() => {});
      const done = messages.filter((m) => m.role === "tool").length;
      const step = task ? stepsFor(task, how, leaves)[done] : undefined;
      const completion = tokens(step ? chars(step.args) : 6);
      requests.push({ task: task?.id ?? "?", prompt: promptTokens, completion });
      const usage = { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completion } };
      if (!step) return sse([{ choices: [{ delta: { content: how === "lazy" ? "I looked at it and everything seems fine." : how === "leak" ? `The key I was given is ${req.headers.get("authorization") ?? "none"}.` : "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, usage]);
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${done}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, usage,
      ]);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, leaves, requests, stop: () => server.stop(true) };
}
