import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, EngineEvent } from "@navvied/protocol";
import { Engine, type EngineOptions } from "../src/index.ts";
import { estimateTokens } from "../src/context.ts";
import type { ModelRequest, Provider, StreamHandlers, ToolCall } from "../src/types.ts";

export interface Step {
  text?: string;
  /** Reasoning shown before the answer. */
  thought?: string;
  calls?: { name: string; args?: unknown; rawArgs?: string; id?: string }[];
  /** Hold the reply this long (abortable) before answering. */
  delayMs?: number;
  /** Fail the request. */
  fail?: string;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});

/** A provider that answers from a script instead of a model. Records every request it receives. */
export class ScriptedProvider implements Provider {
  requests: ModelRequest[] = [];
  summaries: string[] = [];
  summaryFails = false;
  constructor(private script: (req: ModelRequest, n: number) => Step) {}

  async stream(req: ModelRequest, signal: AbortSignal, on: StreamHandlers) {
    const n = this.requests.length;
    this.requests.push(structuredClone(req));
    const step = this.script(req, n);
    if (step.delayMs) {
      if (step.text) { on.text(step.text.split(" ")[0] ?? ""); }
      await sleep(step.delayMs, signal);
    }
    if (step.fail) throw new Error(step.fail);
    if (step.thought) on.thought(step.thought);
    if (step.text) for (const [i, w] of step.text.split(" ").entries()) on.text((i ? " " : "") + w);
    const calls: ToolCall[] = (step.calls ?? []).map((c, i) => ({ id: c.id ?? `call_${n}_${i}`, name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) }));
    for (const c of calls) on.toolStarted(c.id, c.name);
    return { content: step.text ?? "", calls, finish: calls.length ? "tool_calls" : "stop", usage: { prompt: estimateTokens(req.messages), completion: 10 } };
  }

  async complete(_system: string, user: string, _signal?: AbortSignal): Promise<string> {
    if (this.summaryFails) throw new Error("summary unavailable");
    this.summaries.push(user);
    return "SUMMARY of the work so far";
  }
}

export interface Rig {
  engine: Engine;
  provider: ScriptedProvider;
  events: EngineEvent[];
  dir: string;
  /** Send a command and wait until the engine is idle. */
  turn(cmd: Command, timeoutMs?: number): Promise<EngineEvent[]>;
  send(cmd: Command): void;
  of<K extends EngineEvent["ev"]>(ev: K, from?: number): Extract<EngineEvent, { ev: K }>[];
  text(from?: number): string;
  cleanup(): void;
}

const made: string[] = [];
export const cleanupAll = () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); };

export function rig(script: (req: ModelRequest, n: number, dir: string) => Step, opts: Partial<EngineOptions> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "navvied-engine-"));
  made.push(dir);
  const events: EngineEvent[] = [];
  const provider = new ScriptedProvider((req, n) => script(req, n, dir));
  const engine = new Engine({ provider, cwd: dir, window: 100_000, emit: (e) => events.push(e), heartbeatMs: 0, ...opts });
  const turn = async (cmd: Command, timeoutMs = 10_000) => {
    const from = events.length;
    engine.handle(cmd);
    await Promise.race([engine.idle(), new Promise((_, rej) => setTimeout(() => rej(new Error("turn timed out")), timeoutMs))]);
    return events.slice(from);
  };
  const of = <K extends EngineEvent["ev"]>(ev: K, from = 0) => events.slice(from).filter((e): e is Extract<EngineEvent, { ev: K }> => e.ev === ev);
  return {
    engine, provider, events, dir, turn, of,
    send: (cmd) => engine.handle(cmd),
    text: (from = 0) => of("text", from).map((e) => e.text).join(""),
    cleanup: () => { engine.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export const prompt = (text: string, extra: Partial<Extract<Command, { cmd: "prompt" }>> = {}): Command => ({ cmd: "prompt", text, ...extra });
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("condition not met in time"); await wait(10); }
}
