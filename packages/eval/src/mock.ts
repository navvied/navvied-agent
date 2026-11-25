import type { Task } from "./task.ts";
import { solver } from "../fixtures/mc2-solve.ts";
import { repoFiles, solutionFiles, solutionScript } from "./task.ts";

/**
 * A scripted model that speaks the chat completions protocol, for trying the harness and the tasks without a real model.
 * `oracle` does what the task's reference solution does, through the agent's own tools: so a task is shown to be solvable by a real
 * agent run, not only by the validator. The others fail in one known way each, so every reason a run can fail is seen.
 */
export type Behaviour =
  | "oracle"  // writes the solution's files, runs its script, says it is done; a task with a stepwise solution gets its tool calls one by one
  | "code"    // does the work in one call of the code tool when the task has a script for it, and as the oracle does otherwise
  | "lazy"    // says it looked and changes nothing
  | "tamper"  // rewrites a protected file, then says it is done
  | "unplanned" // does what the oracle does, but keeps no task list
  | "leave"   // does what the oracle does, then leaves a program running
  | "leak"    // says the key it was sent, and changes nothing
  | "stall"   // does the work of the oracle, then never answers the last request (its time runs out with the task done)
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

interface Step { tool: string; args: Record<string, unknown> }
/** The calls the model makes in one step: several at once when it hands work to helpers side by side. */
type Round = Step[];

/** A careful model reads a file before it replaces it, as the tools require: one Read for each of these files that the task starts with. */
const reads = (task: Task, files: string[]): Step[] => files.filter((f) => f in repoFiles(task)).map((file_path) => ({ tool: "Read", args: { file_path } }));

/** What a model that can see reads off the last picture it was sent: the text chunk of the PNG (the tasks that show a picture put their answer there). */
function pictureText(messages: { content: unknown }[]): string {
  for (const m of [...messages].reverse()) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { type?: string; image_url?: { url?: string } }[]) {
      const data = p.type === "image_url" ? p.image_url?.url?.split(",")[1] : undefined;
      if (!data) continue;
      const png = Buffer.from(data, "base64");
      for (let at = 8; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) if (png.toString("latin1", at + 4, at + 8) === "tEXt") return png.toString("latin1", at + 8, at + 8 + png.readUInt32BE(at)).split("\0")[1] ?? "";
    }
  }
  return "no picture was shown";
}

/** The step with what the model has seen put in: see `ScriptedCall`. */
function filled(step: Step, messages: { role: string; content: unknown }[]): Step {
  const lastResult = [...messages].reverse().find((m) => m.role === "tool")?.content;
  const fill = (v: unknown): unknown => (typeof v === "string"
    ? v.replace(/\$\{result:([^}]+)\}/g, (_, re: string) => (typeof lastResult === "string" ? new RegExp(re).exec(lastResult)?.[1] : undefined) ?? "not found in the result").replace("${picture}", () => pictureText(messages))
    : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
  return { tool: step.tool, args: fill(step.args) as Record<string, unknown> };
}

/** The task list at one point of the work: what is before it done, it in progress, the rest waiting. */
const listAt = (items: readonly string[], at: number): Step => ({ tool: "TodoWrite", args: { todos: items.map((content, i) => ({ content, status: i < at ? "completed" : i === at ? "in_progress" : "pending", activeForm: `Working on: ${content}` })) } });

/** What the scripted model does before the solution: keeps its list, asks its questions, hands research to helpers. None of it depends on what comes back. */
function openingFor(task: Task, planned = true): Round[] {
  const o = task.oracle;
  return [
    ...(planned && o?.plan?.length ? [[listAt(o.plan, 0)]] : []),
    ...(o?.ask?.length ? [[{ tool: "AskUserQuestion" as const, args: { questions: o.ask } }]] : []),
    ...(o?.helpers?.length ? [o.helpers.map((h): Step => ({ tool: "Agent", args: { description: "research", prompt: h.prompt } }))] : []),
  ];
}

/** What the scripted model was told, read back from the results it has: the answers it was given and what each helper reported. */
function valuesOf(task: Task, results: readonly string[], planned: boolean): { answers: string[]; helpers: string[] } {
  const rounds = openingFor(task, planned);
  let at = 0;
  const values = { answers: [] as string[], helpers: [] as string[] };
  for (const round of rounds) {
    for (const step of round) {
      const result = results[at++] ?? "";
      if (step.tool === "AskUserQuestion") values.answers.push(...[...result.matchAll(/-> "(.*)"$/gm)].map((m) => m[1]!));
      else if (step.tool === "Agent") values.helpers.push(result);
    }
  }
  return values;
}

/** A task with a stepwise solution (see mc2-solve.ts): its calls, one at a time, as far as the results so far allow; the next call is decided by what the last one gave. */
function stepwiseRounds(task: Task, results: readonly string[]): Round[] | undefined {
  const solution = solver(task.id);
  if (!solution) return undefined;
  const rounds: Round[] = [];
  for (let step = solution.next(), i = 0; !step.done; step = solution.next(results[i++] ?? "")) {
    rounds.push([{ tool: step.value.tool, args: step.value.args }]);
    if (i >= results.length) break;
  }
  return rounds;
}

function roundsFor(task: Task, behaviour: Behaviour, leaves: string, results: readonly string[]): Round[] {
  if (behaviour === "stall") behaviour = "oracle";
  if (behaviour === "lazy" || behaviour === "leak" || behaviour === "crash" || behaviour === "hang") return [];
  if (behaviour === "tamper") {
    const protectedFile = Object.keys(repoFiles(task)).find((f) => task.protect.some((p) => new Bun.Glob(p).match(f)));
    return protectedFile ? [...reads(task, [protectedFile]).map((s) => [s]), [{ tool: "Write", args: { file_path: protectedFile, content: "// rewritten by the model\n" } }]] : [];
  }
  if (task.script) return task.script.map((step) => [step]);
  const code = behaviour === "code" ? solutionScript(task) : undefined;
  if (code !== undefined) return [[{ tool: "ExecuteCode", args: { code } }]];
  const stepwise = stepwiseRounds(task, results);
  if (stepwise) return stepwise;
  const planned = behaviour !== "unplanned";
  const files = solutionFiles(task, valuesOf(task, results, planned));
  const script = files["apply.sh"];
  delete files["apply.sh"];
  const steps: Step[] = Object.entries(files).flatMap(([file_path, content]) => [...reads(task, [file_path]), { tool: "Write", args: { file_path, content } }]);
  if (script !== undefined) steps.push({ tool: "Bash", args: { command: script, description: "apply the solution" } });
  if (behaviour === "leave") steps.push({ tool: "Bash", args: { command: `(${leaves} >/dev/null 2>&1 &)`, description: "leave something running" } });
  const plan = planned ? task.oracle?.plan : undefined;
  return [...openingFor(task, planned), ...steps.flatMap((step, i): Round[] => (plan && i > 0 && i < plan.length ? [[listAt(plan, i)], [step]] : [[step]])), ...(plan ? [[listAt(plan, plan.length)]] : [])];
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
      const results = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
      // A helper is asked with the tools that only read: it answers with what the task says it found.
      const tools = ((body as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((t) => t.function?.name);
      const helper = task && !tools.includes("Write") ? task.oracle?.helpers?.find((h) => JSON.stringify(messages).includes(h.prompt)) : undefined;
      const rounds = task && !helper ? roundsFor(task, how, leaves, results) : [];
      let used = 0;
      const round = rounds.find((r) => (used += r.length) > results.length);
      if (how === "stall" && !round && !helper) return new Promise<Response>(() => {});
      const sent = round?.map((s) => filled(s, messages));
      const completion = tokens(sent ? chars(sent.map((s) => s.args)) : 6);
      requests.push({ task: task?.id ?? "?", prompt: promptTokens, completion });
      const usage = { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completion } };
      if (!round) return sse([{ choices: [{ delta: { content: helper ? helper.says : how === "lazy" ? "I looked at it and everything seems fine." : how === "leak" ? `The key I was given is ${req.headers.get("authorization") ?? "none"}.` : "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, usage]);
      return sse([
        { choices: [{ delta: { tool_calls: sent!.map((step, index) => ({ index, id: `call_${results.length}_${index}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } })) } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, usage,
      ]);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, leaves, requests, stop: () => server.stop(true) };
}
