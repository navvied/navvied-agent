import { readFileSync } from "node:fs";
import { jsonIn, validateJson } from "@navvied/engine";
import { EventEncoder, type EngineEvent } from "@navvied/protocol";
import type { Options } from "../args.ts";
import { createEngine } from "../create.ts";
import type { IO } from "../io.ts";
import { Renderer } from "../render.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const;

async function readAll(stdin: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

export async function runCommand(prompt: string | undefined, options: Options, io: IO): Promise<number> {
  // The task is the argument, or (when piped) standard input: `echo "fix it" | navvied run`.
  const task = (prompt ?? (io.interactive ? "" : await readAll(io.stdin))).trim();
  if (!task) { io.stderr.write('error: no task given. Usage: navvied run "fix the failing test"\n'); return EXIT.usage; }

  let schema: unknown;
  if (options.schema) {
    try { schema = JSON.parse(readFileSync(options.schema, "utf8")); } catch (e) { io.stderr.write(`error: --schema ${options.schema}: ${e instanceof Error ? e.message : "cannot be read"}\n`); return EXIT.usage; }
  }
  const quiet = schema !== undefined || options.last === true;
  const renderer = new Renderer(io, { thinking: options.thinking });
  /** What the model said after its last tool: the final answer. */
  let answer = "";
  const encoder = new EventEncoder();
  let failed = false, stop = "end_turn", note = false;
  let created: ReturnType<typeof createEngine> | undefined;

  const emit = (e: EngineEvent): void => {
    if (e.ev === "text") answer += e.text;
    if (e.ev === "tool" && e.status === "running") answer = "";
    if (options.json) io.stdout.write(encoder.encode(e)); else if (!quiet) renderer.handle(e);
    else if (e.ev === "error" || e.ev === "notice") io.stderr.write(`${e.ev === "error" ? "error: " : ""}${e.msg}\n`);
    if (e.ev === "error") failed = true;
    if (e.ev === "done") stop = e.stop;
    if (e.ev === "approval" && created?.ok) {
      // No person to ask: approve only when told to; otherwise refuse and say how to allow it.
      created.value.engine.handle({ cmd: "approve", id: e.id, optionId: options.yes ? "allow" : "deny" });
      if (!options.yes && !note && !options.json) { note = true; io.stderr.write("denied: no one to ask. Use --yes to allow tool calls, or --mode bypass.\n"); }
    }
  };

  created = createEngine(options, io, emit);
  if (!created.ok) { io.stderr.write(`error: ${created.error}\n`); return EXIT.usage; }
  const { engine } = created.value;

  let interrupts = 0;
  let force!: () => void;
  const forced = new Promise<void>((resolve) => { force = resolve; });
  const off = io.onInterrupt(() => { interrupts += 1; if (interrupts === 1) engine.handle({ cmd: "cancel" }); else force(); });

  const ask = async (text: string): Promise<void> => {
    answer = "";
    engine.handle({ cmd: "prompt", text, qid: crypto.randomUUID(), mode: options.mode ?? "auto", ...(options.effort ? { effort: options.effort } : {}) });
    await Promise.race([engine.idle(), forced]);
  };
  await ask(schema === undefined ? task : `${task}\n\nWhen you are done, answer with only a JSON value that matches this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`);
  let schemaFailed = false;
  if (schema !== undefined && !failed && interrupts === 0) {
    // One chance to put it right: say exactly what was wrong.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = jsonIn(answer);
      const problems = found.ok ? validateJson(found.value, schema) : [found.error];
      if (problems.length === 0 && found.ok) { io.stdout.write(`${JSON.stringify(found.value)}\n`); break; }
      if (attempt === 1) { schemaFailed = true; io.stderr.write(`error: the answer does not match the schema:\n${problems.slice(0, 8).map((p) => `  ${p}`).join("\n")}\n`); break; }
      await ask(`That answer does not match the schema: ${problems.slice(0, 8).join("; ")}. Answer again with only the corrected JSON.`);
    }
  } else if (options.last && !options.json) io.stdout.write(`${answer.trim()}\n`);
  off();
  engine.close();

  if (interrupts > 1 || stop === "cancelled") return EXIT.cancelled;
  return failed || schemaFailed || stop === "error" ? EXIT.failed : EXIT.ok;
}
