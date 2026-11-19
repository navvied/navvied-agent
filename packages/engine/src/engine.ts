/**
 * The engine: one conversation, one agent loop. It receives protocol commands and emits protocol events; everything it needs
 * from the outside (model provider, session store, tools, clock) is passed in, so a whole run can be tested against a script.
 */
import { historyOf } from "./store.ts";
import { resolve } from "node:path";
import { RecentIds, type Command, type Effort, type EngineEvent, type ModelInfo, type PermMode, type PromptCommand, type SessionKind, type StopReason, type ToolOutcome, type TurnTokens } from "@navvied/protocol";
import { ALLOW, ALLOW_ALWAYS, ApprovalBroker, EDIT, approvalOptions } from "./approvals.ts";
import { approvalScope } from "./approval-scope.ts";
import type { Checkpoint, Checkpoints } from "./checkpoints.ts";
import type { AgentEngine } from "./contract.ts";
import { KEEP_TAIL, compactMessages, estimateTokens, shouldCompact } from "./context.ts";
import { parseLenient } from "./lenient-json.ts";
import type { Hooks } from "./hooks.ts";
import type { MemoryPaths } from "./memory.ts";
import { approvalChange } from "./approval-change.ts";
import { Jobs } from "./jobs.ts";
import { skillsPrompt, type SkillInfo } from "./skills.ts";
import { TextToolCalls } from "./text-tool-calls.ts";
import type { Backend } from "./backend.ts";
import { needsApproval, toolsFor } from "./permissions.ts";
import { riskOf } from "./risk.ts";
import { isConfined, profileTools } from "./profiles.ts";
import { hardBlock, type Rules } from "./rules.ts";
import { systemPrompt } from "./prompt.ts";
import { PLAN_TOOL_NAME, defaultTools } from "./tools/index.ts";
import { AGENT_TOOL_NAME, agentTool } from "./tools/agent.ts";
import type { AgentDef } from "./agents.ts";
import type { Message, ModelReply, Part, Provider, Recall, SessionStore, Tool, ToolCall, WebProxy } from "./types.ts";

/** What the engine needs to let a person switch models in the middle of a conversation. */
export interface ModelSwitch {
  /** What can be switched to. The engine marks the one in use. */
  models: ModelInfo[];
  /** The id of the one in use. */
  current: string;
  /** The effort levels the model in use supports; none when it has no such setting. */
  efforts?: Effort[];
  /** What it takes to use another: its provider and window, and the effort levels it supports. */
  use(id: string): { provider: Provider; window: number; efforts?: Effort[]; persona?: string } | { error: string };
}

export interface EngineOptions {
  provider: Provider;
  cwd: string;
  window: number;
  emit: (event: EngineEvent) => void;
  store?: SessionStore;
  /** Continue a saved session (needs `store`). */
  sessionId?: string;
  persona?: string;
  instructions?: () => string | undefined;
  checkpoints?: Checkpoints;
  tools?: Tool[];
  /** Where Bash runs its commands: a container or another machine instead of this computer. */
  backend?: Backend;
  /** Nobody can be asked (a helper): what would be asked about is refused instead. */
  noQuestions?: boolean;
  /** The person's earlier conversations, for the Recall tool. */
  recall?: Recall;
  allowPrivateNetwork?: boolean;
  /** Model calls allowed in one turn before the engine stops (default 60). */
  maxSteps?: number;
  /** Heartbeat interval while working, ms (default 15000; 0 disables). */
  heartbeatMs?: number;
  now?: () => Date;
  switcher?: ModelSwitch;
  /** A search server to use instead of the public search page (it must answer in JSON, as SearXNG does). */
  search?: { url?: string };
  /** The service that fetches and searches the web for a session that has no network of its own. */
  webProxy?: WebProxy;
  /** The skills in effect, read again each turn so a new one is seen without a restart. */
  skills?: () => SkillInfo[];
  /** Commands the person runs around what the agent does. */
  hooks?: Hooks;
  /** Helpers the person defined in Markdown files (see agents.ts). */
  agents?: AgentDef[];
  /** The person's own allow / ask / deny rules (see rules.ts). */
  rules?: Rules;
  /** Where notes are kept between conversations. */
  memory?: MemoryPaths;
  /** What the conversation is for (default `agent`). A `chat` works in `cwd` only, offers a smaller set of tools and asks the person nothing. */
  kind?: SessionKind;
  /** The program runs inside a sandbox, so a chat may run commands too. */
  sandboxed?: boolean;
  /** The one model in use, for a page that shows it, when there is no list to switch between. */
  model?: ModelInfo;
}

interface Queued { qid?: string; text: string; images: NonNullable<PromptCommand["images"]> }

/** `{"path": "...", "limit": 0}`: what a call to a tool looks like, from its parameter schema. */
function exampleArguments(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(props).slice(0, 2);
  const sample = (type: string | undefined): string => (type === "number" ? "0" : type === "boolean" ? "true" : '"..."');
  return `{${required.map((k) => `"${k}": ${sample(props[k]?.type)}`).join(", ")}}`;
}

/** A context window this small, or smaller, marks a model that needs a lighter touch. */
export const SMALL_WINDOW = 40_000;
/** The steps a helper may take before it must answer. */
/** How often what a running command printed is sent on, and the most of it that is. */
const LIVE_EVERY_MS = 150;
const LIVE_MOST = 200_000;
const HELPER_STEPS = 25;

const asParts = (q: Queued): string | Part[] =>
  q.images.length ? [...(q.text ? [{ type: "text" as const, text: q.text }] : []), ...q.images.map((i) => ({ type: "image" as const, mime: i.mime, data: i.data }))] : q.text;

/** Run a collaborator's code that must never be able to stop a turn: a failure counts as "no result". */
function attempt<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

export class Engine implements AgentEngine {
  sessionId: string;
  readonly #o: Required<Pick<EngineOptions, "provider" | "cwd" | "window" | "emit" | "maxSteps" | "allowPrivateNetwork">> & EngineOptions;
  readonly #tools: Tool[];
  readonly #disposers: (() => void)[] = [];
  #loading: Promise<void>[] = [];
  readonly #approvals = new ApprovalBroker();
  readonly #queue: Queued[] = [];
  /** A model chosen while a turn was being answered: it is used from the next one. */
  #wantModel: string | undefined;
  #messages: Message[] = [];
  #mode: PermMode = "auto";
  get #kind(): SessionKind { return this.#o.kind ?? "agent"; }
  #effort: Effort | undefined;
  #provider: Provider;
  #window: number;
  #persona: string | undefined;
  #model: string | undefined;
  #efforts: Effort[] | undefined;
  #busy = false;
  readonly #qids = new RecentIds();
  /** The prompt that started the running turn, and what the turn has used so far. */
  #turnQid: string | undefined;
  #turnTokens: TurnTokens = { in: 0, out: 0, calls: 0 };
  /** The first message of the session has been through the hooks. */
  #hooked = false;
  #cancelled = false;
  /** Kinds of action the person said not to ask about again, until this engine closes. */
  readonly #allowed = new Set<string>();
  readonly #jobs = new Jobs((e) => this.#emit(e));
  readonly #closing = new AbortController();
  #abort = new AbortController();
  #lastContext = 0;
  #written = new Set<string>();
  #checkpoint: Checkpoint | undefined;
  #running: Promise<void> = Promise.resolve();
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(opts: EngineOptions) {
    this.#o = { maxSteps: 60, allowPrivateNetwork: false, ...opts };
    this.#provider = opts.provider;
    this.#window = opts.window;
    this.#persona = opts.persona;
    this.#model = opts.switcher?.current;
    this.#efforts = opts.switcher?.efforts;
    this.#tools = profileTools(opts.kind ?? "agent", opts.tools ?? defaultTools(), { sandboxed: opts.sandboxed === true }).map((t) => (t.name === AGENT_TOOL_NAME && opts.agents?.length ? agentTool(opts.agents) : t));
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    if (opts.sessionId && opts.store) this.#messages = opts.store.load(opts.sessionId) ?? [];
    const every = opts.heartbeatMs ?? 15_000;
    if (every > 0) {
      this.#heartbeat = setInterval(() => { if (this.#busy) this.#emit({ ev: "alive" }); }, every);
      this.#heartbeat.unref?.();
    }
    this.#emit({ ev: "session", id: this.sessionId });
    this.#announce();
    if (this.#messages.length) this.#emit({ ev: "usage", ctx: estimateTokens(this.#messages), win: this.#window, out: 0 });
  }

  /** Feed one command. Returns at once; work continues in the background (see {@link idle}). */
  handle(cmd: Command): void {
    switch (cmd.cmd) {
      case "prompt": return this.#prompt(cmd);
      case "cancel": return this.#cancel();
      case "job.stop": this.#jobs.stop(cmd.id); return;
      case "approve": this.#approvals.answer(cmd.id, cmd.optionId, cmd.input); return;
      case "compact": return this.#compactCommand();
      case "model": return this.#useModel(cmd.id);
      case "effort": return this.#setEffort(cmd.level);
      case "load": return this.#load(cmd.id);
      case "sessions": return this.#emit({ ev: "sessions", items: this.#o.store?.list?.() ?? [] });
      case "checkpoints": return this.#listCheckpoints();
      case "restore": return this.#restore(cmd.id, cmd.preview === true);
    }
  }

  /** Add tools after the engine has started, such as those of connected programs. They are offered from the next step. `dispose` runs when the engine closes. */
  addTools(tools: Tool[], dispose?: () => void): void {
    for (const t of tools) if (!this.#tools.some((x) => x.name === t.name)) this.#tools.push(t);
    if (dispose) this.#disposers.push(dispose);
  }

  /** Tools that are still being connected. The first step of the next turn waits for them, so no turn starts without tools that are about to arrive. Programs that fail are reported as errors, and the rest go on. */
  loadTools(load: Promise<{ tools: Tool[]; close(): void; problems?: { server: string; reason: string }[] }>): void {
    this.#loading.push(load.then((c) => {
      if (this.#closing.signal.aborted) { attempt(() => c.close()); return; }
      this.addTools(c.tools, () => c.close());
      for (const p of c.problems ?? []) this.#emit({ ev: "notice", msg: `The connected program "${p.server}" could not be used: ${p.reason}` });
    }, () => undefined));
  }

  async idle(): Promise<void> { await this.#running; }

  /** Aborted when the engine is closed: what is still being connected (see `connectMcp`) is stopped then. */
  get closing(): AbortSignal { return this.#closing.signal; }

  close(): void {
    this.#closing.abort();
    this.#cancel();
    this.#jobs.close();
    for (const dispose of this.#disposers.splice(0)) attempt(dispose);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
  }

  #prompt(cmd: PromptCommand): void {
    if (cmd.qid && !this.#qids.isNew(cmd.qid)) return;
    if (cmd.mode && this.#kind === "agent") this.#mode = cmd.mode;
    if (cmd.effort) this.#effort = cmd.effort;
    const item: Queued = { text: cmd.text, images: cmd.images ?? [], ...(cmd.qid ? { qid: cmd.qid } : {}) };
    if (this.#busy) { this.#queue.push(item); if (item.qid) this.#emit({ ev: "queued", qid: item.qid, text: item.text, ...(item.images.length ? { images: item.images.length } : {}) }); return; }
    this.#busy = true;
    this.#running = this.#turn(item);
  }

  /** Messages that were waiting and will not run: every window is told, so none stays on the screen as waiting for ever. */
  #dropQueue(): void {
    const qids = this.#queue.flatMap((q) => (q.qid ? [q.qid] : []));
    this.#queue.length = 0;
    if (qids.length) this.#emit({ ev: "dropped", qids });
  }

  #cancel(): void {
    if (!this.#busy) return;
    this.#cancelled = true;
    this.#dropQueue();
    this.#abort.abort();
    this.#approvals.denyAll();
  }

  /** What this engine can do right now. Sent at the start and again whenever the model or the effort changes. */
  #announce(): void {
    const sw = this.#o.switcher;
    this.#emit({
      ev: "caps", steer: true, ...(this.#kind === "chat" ? { kind: "chat" as const, modes: [] } : { modes: ["ask", "edits", "plan", "auto", "bypass"] as PermMode[], defaultMode: "auto" as const }), compact: true,
      ...(this.#o.checkpoints && this.#kind === "agent" ? { checkpoints: true } : {}),
      ...(sw ? { models: sw.models.map((m) => ({ ...m, current: m.id === (this.#wantModel ?? this.#model) })) } : this.#o.model ? { models: [{ ...this.#o.model, current: true }] } : {}),
      ...(this.#efforts?.length ? { efforts: this.#efforts } : {}),
      ...(this.#effort ? { effort: this.#effort } : {}),
    });
  }

  /**
   * Switch models. The choice is made at once (every window is shown the new model as the current one) and reaches the next message:
   * a turn that is being answered finishes with the model it started with, as in every other app. A conversation too long for the new
   * model is summarised first, by the model that can still read it.
   */
  #useModel(id: string): void {
    const sw = this.#o.switcher;
    if (!sw) { this.#emit({ ev: "error", msg: "This engine has only one model." }); return; }
    if (id === (this.#wantModel ?? this.#model)) return;
    const check = sw.use(id);
    if ("error" in check) { this.#emit({ ev: "error", msg: check.error }); return; }
    if (this.#busy) { this.#wantModel = id; this.#announce(); return; }
    this.#wantModel = id;
    this.#busy = true;
    this.#abort = new AbortController();
    this.#running = (async () => {
      const fits = await this.#applyWantedModel();
      this.#lastContext = estimateTokens(this.#messages);
      this.#busy = false;
      this.#announce();
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 });
      this.#emit({ ev: "done", stop: fits ? "end_turn" : "error" });
    })();
  }

  /** Puts the model that was chosen in use (between two turns), summarising first when the conversation is too long for it. False when it cannot be done. */
  async #applyWantedModel(): Promise<boolean> {
    const id = this.#wantModel;
    const sw = this.#o.switcher;
    if (!id || !sw) return true;
    this.#wantModel = undefined;
    if (id === this.#model) return true;
    const next = sw.use(id);
    if ("error" in next) { this.#emit({ ev: "error", msg: next.error }); return false; }
    let fits = !shouldCompact(estimateTokens(this.#messages), next.window);
    for (const keep of [KEEP_TAIL, 2]) {
      if (fits) break;
      await this.#compact(false, keep);
      fits = !shouldCompact(estimateTokens(this.#messages), next.window);
    }
    if (fits) {
      this.#provider = next.provider;
      this.#window = next.window;
      if (next.persona !== undefined) this.#persona = next.persona;
      this.#model = id;
      this.#efforts = next.efforts;
      if (this.#effort && !next.efforts?.includes(this.#effort)) this.#effort = undefined;
    } else this.#emit({ ev: "error", msg: "The last messages are longer than that model can read, so nothing was changed. Choose a model with more room." });
    this.#announce();
    return fits;
  }

  #setEffort(level: Effort | "auto"): void {
    if (level === "auto") { this.#effort = undefined; this.#announce(); return; }
    if (!this.#efforts?.includes(level)) { this.#emit({ ev: "error", msg: this.#efforts?.length ? `This model does not have the effort level ${level}.` : "This model has no effort setting." }); return; }
    this.#effort = level;
    this.#announce();
  }

  #compactCommand(): void {
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish, then compact." }); return; }
    this.#busy = true;
    this.#abort = new AbortController();
    this.#running = this.#compact(true).then((ok) => { this.#busy = false; this.#emit({ ev: "done", stop: ok ? "compacted" : "error" }); });
  }

  #listCheckpoints(): void {
    const store = this.#o.checkpoints;
    if (!store) { this.#emit({ ev: "error", msg: "Checkpoints are not enabled for this session." }); return; }
    this.#emit({ ev: "checkpoints", items: store.info() });
  }

  #restore(id: string, preview: boolean): void {
    const store = this.#o.checkpoints;
    if (!store) { this.#emit({ ev: "error", msg: "Checkpoints are not enabled for this session." }); return; }
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish before restoring." }); return; }
    if (preview) {
      const changes = store.preview(id);
      if (changes) this.#emit({ ev: "restore", id, preview: true, changes });
      else this.#emit({ ev: "error", msg: "That checkpoint was not found." });
      return;
    }
    const done = store.restore(id);
    if (!done) { this.#emit({ ev: "error", msg: "That checkpoint was not found." }); return; }
    for (const msg of done.errors) this.#emit({ ev: "error", msg });
    this.#emit({ ev: "restore", id, preview: false, changes: done.changes, ...(done.undoId ? { undoId: done.undoId } : {}) });
  }

  #load(id: string): void {
    if (this.#busy) { this.#emit({ ev: "error", msg: "Wait for the current turn to finish before loading another session." }); return; }
    const saved = this.#o.store?.load(id);
    if (!saved) { this.#emit({ ev: "error", msg: "That session was not found." }); return; }
    this.#messages = saved;
    this.sessionId = id;
    this.#emit({ ev: "loaded", id, items: historyOf(saved) });
    this.#emit({ ev: "usage", ctx: estimateTokens(saved), win: this.#window, out: 0 });
  }

  async #turn(first: Queued): Promise<void> {
    this.#cancelled = false;
    this.#abort = new AbortController();
    let stop: StopReason = "end_turn";
    try {
      let next: Queued | undefined = first;
      while (next) {
        if (this.#o.hooks?.prompt) {
          const verdict = await this.#o.hooks.prompt({ text: next.text, first: !this.#hooked }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined, context: undefined }));
          this.#hooked = true;
          for (const note of verdict.notes) this.#emit({ ev: "notice", msg: note });
          if (verdict.block) { this.#emit({ ev: "error", msg: `Blocked by a hook: ${verdict.block}` }); next = this.#queue.shift(); continue; }
          if (verdict.context) next = { ...next, text: `${next.text}\n\n[Added by the user's hook]\n${verdict.context}` };
        }
        await this.#applyWantedModel();
        this.#take(next, true);
        next = undefined;
        await this.#steps();
        this.#save();
        if (this.#cancelled) break;
        next = this.#queue.shift(); // sent too late to steer into the turn: it runs as its own
      }
      if (this.#cancelled) stop = "cancelled";
    } catch (e) {
      if (this.#cancelled) stop = "cancelled";
      else { this.#emit({ ev: "error", msg: e instanceof Error ? e.message : String(e) }); stop = "error"; }
      this.#save();
    } finally {
      // A model chosen during this turn takes effect now, so the next message finds it in use.
      try { await this.#applyWantedModel(); } catch { /* the model stays as it was */ }
      this.#busy = false;
      this.#dropQueue();
      this.#emit({ ev: "done", stop });
      if (this.#o.hooks) void this.#o.hooks.stop({ reason: stop }).then((r) => { for (const note of r.notes) this.#emit({ ev: "notice", msg: note }); }).catch(() => undefined);
    }
  }

  #take(q: Queued, startsTurn = false): void {
    if (startsTurn) { this.#turnQid = q.qid; this.#turnTokens = { in: 0, out: 0, calls: 0 }; }
    if (startsTurn && this.#kind === "agent") this.#checkpoint = attempt(() => this.#o.checkpoints?.begin(q.text || "Message", [this.#o.cwd, ...this.#written]));
    if (q.qid) {
      this.#emit({ ev: "user", qid: q.qid, text: q.text, ...(q.images.length ? { images: q.images.length } : {}) });
      this.#emit({ ev: "taken", qid: q.qid });
    }
    this.#messages.push({ role: "user", content: asParts(q) });
  }

  /** Everything the person has written so far, to decide which tools are worth offering. */
  #userText(): string {
    return this.#messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" "))).join("\n");
  }

  async #steps(): Promise<void> {
    if (this.#loading.length) await Promise.all(this.#loading.splice(0));
    for (let step = 0; step < this.#o.maxSteps; step++) {
      if (this.#cancelled) return;
      if (shouldCompact(this.#lastContext, this.#window)) await this.#compact();
      if (this.#cancelled) return;

      const small = this.#window <= SMALL_WINDOW;
      const skills = attempt(() => this.#o.skills?.()) ?? [];
      const tools = toolsFor(this.#mode, this.#tools, { small, userText: this.#userText(), jobs: this.#jobs.running, typable: this.#jobs.typable, skills: skills.length, recall: this.#o.recall !== undefined });
      const instructions = attempt(() => this.#o.instructions?.());
      const written = new TextToolCalls(Object.fromEntries(tools.map((t) => [t.name, t.parameters as { properties?: Record<string, { type?: string }> }])), `text${this.#messages.length}_`);
      let thinkingSince: number | undefined;
      const endThought = (): void => { if (thinkingSince !== undefined) { this.#emit({ ev: "thought_end", ms: Date.now() - thinkingSince }); thinkingSince = undefined; } };
      const said = (text: string): void => { if (text) { endThought(); this.#emit({ ev: "text", text }); } };
      const model = await this.#provider.stream(
        {
          system: systemPrompt({ cwd: this.#o.cwd, platform: process.platform, date: (this.#o.now?.() ?? new Date()).toISOString().slice(0, 10), ...(this.#persona ? { persona: this.#persona } : {}), ...(instructions ? { instructions } : {}), ...(skills.length ? { skills: skillsPrompt(skills, small)! } : {}), small, ...(this.#kind === "chat" ? { kind: "chat" as const, sandboxed: this.#o.sandboxed === true } : {}) }, this.#mode),
          messages: this.#messages,
          tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
          ...(this.#effort ? { effort: this.#effort } : {}),
        },
        this.#abort.signal,
        {
          text: (text) => said(written.push(text)),
          thought: (text) => { thinkingSince ??= Date.now(); this.#emit({ ev: "thought", text }); },
          toolStarted: (id, name) => { endThought(); if (name !== PLAN_TOOL_NAME) this.#emit({ ev: "tool", id, name, status: "running", progress: 0 }); },
        },
      );

      said(written.finish());
      endThought();
      const reply: ModelReply = written.calls.length || written.shown !== model.content ? { ...model, content: written.shown, calls: [...model.calls, ...written.calls] } : model;
      this.#lastContext = reply.usage?.prompt || estimateTokens(this.#messages);
      this.#turnTokens = { in: this.#turnTokens.in + this.#lastContext, out: this.#turnTokens.out + (reply.usage?.completion ?? 0), calls: this.#turnTokens.calls + 1 };
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: reply.usage?.completion ?? 0, turn: { ...this.#turnTokens } });
      if (reply.content || reply.calls.length) this.#messages.push({ role: "assistant", ...(reply.content ? { content: reply.content } : {}), ...(reply.calls.length ? { toolCalls: reply.calls } : {}) });

      if (!reply.calls.length) {
        if (this.#mode === "plan" && reply.content.trim()) this.#emit({ ev: "plan_proposal", id: `plan${this.#messages.length}` });
        return;
      }
      if (this.#mode === "plan" && this.#presentPlan(reply)) return;

      // Helpers (and other tools that only read) asked for in the same step run side by side; anything that may change something runs alone and in order, because it may need an answer from the person.
      const writesLater = (c: ToolCall): boolean => { // a helper allowed to change things must not run beside another one
        if (c.name !== AGENT_TOOL_NAME || (this.#mode !== "auto" && this.#mode !== "bypass")) return false;
        const named = parseLenient(c.arguments)?.agent;
        return typeof named === "string" && !!this.#o.agents?.find((d) => d.name === named)?.tools;
      };
      const together = reply.calls.length > 1 && reply.calls.every((c) => { const t = tools.find((x) => x.name === c.name); return t?.readOnly === true && !writesLater(c); });
      if (together) {
        const outputs = await Promise.all(reply.calls.map((call) => (this.#cancelled ? "[interrupted]" : this.#runTool(call, tools))));
        reply.calls.forEach((call, i) => this.#messages.push({ role: "tool", toolCallId: call.id, content: outputs[i]! }));
      } else {
        // The ones that wait for their turn are shown as waiting; any that never get it (the turn was stopped) are shown as skipped.
        for (const call of reply.calls.slice(1)) { const input = parseLenient(call.arguments); this.#emit({ ev: "tool", id: call.id, name: call.name, status: "running", queued: true, ...(input ? { input } : {}) }); }
        for (const call of reply.calls) {
          if (this.#cancelled) {
            this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: "[interrupted]", outcome: "skipped" });
            this.#messages.push({ role: "tool", toolCallId: call.id, content: "[interrupted]" });
            continue;
          }
          // The person sent a new message while this step waited its turn: it takes the place of the rest of the step.
          if (this.#queue.length) {
            this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: "[redirected]", outcome: "redirected" });
            this.#messages.push({ role: "tool", toolCallId: call.id, content: "[not run: the person sent a new message first]" });
            continue;
          }
          const output = await this.#runTool(call, tools);
          this.#messages.push({ role: "tool", toolCallId: call.id, content: output });
        }
      }
      // A message sent while the agent worked is folded in at this step boundary.
      const steer = this.#cancelled ? undefined : this.#queue.shift();
      if (steer) this.#take(steer);
    }
    this.#emit({ ev: "error", msg: `Stopped after ${this.#o.maxSteps} steps. Send a message to continue.` });
  }

  #presentPlan(reply: ModelReply): boolean {
    const exit = reply.calls.find((c) => c.name === PLAN_TOOL_NAME);
    if (!exit) return false;
    let plan = "";
    try { plan = String((JSON.parse(exit.arguments || "{}") as { plan?: unknown }).plan ?? "").trim(); } catch { /* the model sent broken arguments: show its text only */ }
    for (const c of reply.calls) this.#messages.push({ role: "tool", toolCallId: c.id, content: c === exit ? "Plan presented to the user for approval." : "Skipped: planning is finished." });
    this.#emit({ ev: "text", text: `${reply.content ? "\n\n" : ""}${plan}\n` });
    this.#emit({ ev: "plan_proposal", id: `plan${this.#messages.length}` });
    return true;
  }

  /**
   * A helper: a second engine with the same model and only the tools that read. It has no conversation of its own to start
   * from, no helpers of its own, and its steps are shown under the step that asked, so a long search stays out of the way.
   */
  async #delegate(parent: string, task: { description: string; prompt: string; agent?: string }, signal: AbortSignal): Promise<string> {
    let answer = "";
    let steps = 0;
    const def = task.agent ? this.#o.agents?.find((a) => a.name === task.agent) : undefined;
    // A helper may change things only when the person's own definition names the tools and the conversation is in Auto mode: in Ask mode nobody could answer its questions, and in Plan mode nothing may change.
    const writes = !!def?.tools && (this.#mode === "auto" || this.#mode === "bypass");
    const allowed = def?.tools ? this.#tools.filter((t) => def.tools!.includes(t.name) && t.name !== AGENT_TOOL_NAME && (writes || t.readOnly)) : this.#tools.filter((t) => t.readOnly && t.name !== AGENT_TOOL_NAME);
    const helper = new Engine({
      provider: this.#provider, cwd: this.#o.cwd, window: this.#window, heartbeatMs: 0, maxSteps: HELPER_STEPS,
      allowPrivateNetwork: this.#o.allowPrivateNetwork, noQuestions: true,
      tools: allowed,
      ...(this.#o.rules ? { rules: this.#o.rules } : {}),
      ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
      ...(def ? { persona: `${this.#persona ? `${this.#persona}\n\n` : ""}You are the helper "${def.name}". ${def.prompt}` } : this.#persona ? { persona: this.#persona } : {}),
      ...(this.#o.instructions ? { instructions: this.#o.instructions } : {}),
      ...(this.#o.search ? { search: this.#o.search } : {}),
      ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}),
      ...(this.#o.skills ? { skills: this.#o.skills } : {}),
      emit: (e) => {
        if (e.ev === "text") answer += e.text;
        else if (e.ev === "tool") { if (e.status === "running" && e.input !== undefined) { answer = ""; steps++; } this.#emit({ ...e, id: `${parent}.${e.id}`, parent }); }
        else if (e.ev === "error") answer += `\n[the helper had a problem: ${e.msg}]`;
      },
    });
    const stop = (): void => helper.handle({ cmd: "cancel" });
    signal.addEventListener("abort", stop, { once: true });
    try {
      helper.handle({ cmd: "prompt", text: task.prompt, mode: "auto" });
      await helper.idle();
      return signal.aborted ? "[interrupted]" : answer.trim() || (steps ? "The helper looked around but wrote no answer." : "The helper wrote no answer.");
    } finally { signal.removeEventListener("abort", stop); helper.close(); }
  }

  async #runTool(call: ToolCall, offered: Tool[]): Promise<string> {
    let t0 = Date.now();
    const fail = (message: string, outcome?: ToolOutcome): string => { this.#emit({ ev: "tool", id: call.id, name: call.name, status: "error", output: message, ms: Date.now() - t0, ...(outcome ? { outcome } : {}) }); return message; };
    const tool = offered.find((t) => t.name === call.name);
    if (!tool) return fail(`Error: there is no tool "${call.name}". Use one of: ${offered.map((t) => t.name).join(", ")}${this.#mode === "plan" ? " (plan mode only allows reading)" : ""}.`);

    let args = parseLenient(call.arguments);
    if (!args) return fail(`Error: the arguments for ${call.name} must be a JSON object such as ${exampleArguments(tool.parameters)}. Send them again.`);
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: args });

    // What may never be done is stopped in every mode, before anything else is asked.
    const forbidden = hardBlock(tool.name, args, this.#o.cwd);
    if (forbidden) return fail(`Blocked: ${forbidden}. navvied never does this.`, "blocked");
    const verdict = this.#o.rules?.check(tool.name, args) ?? { kind: "none" as const };
    if (verdict.kind === "deny") return fail(`Blocked by the permission rule ${verdict.rule}. Do not try again; tell the user what you wanted to do.`, "blocked");
    // What cannot be undone is asked about in every mode but Bypass, and a rule that allows "git" does not allow it: what is allowed is a kind of thing.
    const risk = tool.readOnly || this.#mode === "plan" || this.#mode === "bypass" ? undefined : riskOf(tool.name, args, this.#o.cwd);
    const riskAsked = risk !== undefined && !this.#allowed.has(risk.key);
    const mustAsk = verdict.kind === "ask" ? this.#mode !== "plan" : riskAsked || (needsApproval(this.#mode, tool, args) && verdict.kind !== "allow");
    if (mustAsk) {
      const scope = riskAsked ? { key: risk!.key, phrase: risk!.phrase } : approvalScope(tool.name, args, this.#o.cwd);
      if (this.#o.noQuestions) return fail(`Blocked: this needs the person's say-so${risk ? ` (${risk.reason})` : ""}, and a helper cannot ask. Do not try again; say what you wanted to do.`, "blocked");
      if (verdict.kind === "ask" || riskAsked || !this.#allowed.has(scope.key)) {
        const { id, answer } = this.#approvals.open();
        const change = approvalChange(tool.name, args);
        // A command can be changed by the person before it is allowed.
        const editable = tool.name === "Bash" && typeof args.command === "string" ? args.command : undefined;
        this.#emit({ ev: "approval", id, title: attempt(() => tool.title(args!)) ?? `Run ${tool.name}`, options: approvalOptions(scope.phrase, editable), tool: call.id, ...(change ? { change } : {}), ...(riskAsked ? { risk: risk!.reason } : {}) });
        const given = await answer;
        if (given.optionId === ALLOW_ALWAYS) this.#allowed.add(scope.key);
        else if (given.optionId === EDIT && editable !== undefined && given.input?.trim()) {
          // What the person typed is held to the same limits as anything else, and shown as the step's new input.
          args = { ...args, command: given.input.trim() };
          const again = hardBlock(tool.name, args, this.#o.cwd);
          if (again) return fail(`Blocked: ${again}. navvied never does this.`, "blocked");
          const rule = this.#o.rules?.check(tool.name, args);
          if (rule?.kind === "deny") return fail(`Blocked by the permission rule ${rule.rule}.`, "blocked");
          this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", input: args });
        } else if (given.optionId !== ALLOW && given.optionId !== EDIT) return fail("The user denied this action.", "denied");
      }
    }
    if (this.#o.hooks) {
      const before = await this.#o.hooks.pre({ tool: tool.name, input: args }, this.#abort.signal).catch(() => ({ notes: [] as string[], block: undefined }));
      for (const note of before.notes) this.#emit({ ev: "notice", msg: note });
      if (before.block) return fail(`Blocked by a hook: ${before.block}`, "blocked");
    }
    if (this.#abort.signal.aborted) return fail("[interrupted]", "stopped");
    if (!tool.readOnly) this.#beforeWrite(args);
    // How long it took is how long it ran, not how long the person took to answer.
    t0 = Date.now();

    // What a command prints is passed on a little at a time; how it ended is reported by the tool.
    let pending = "", sent = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => { timer = undefined; if (pending) { this.#emit({ ev: "tool", id: call.id, name: tool.name, status: "running", live: pending }); pending = ""; } };
    const live = (chunk: string): void => { if (sent > LIVE_MOST) return; sent += chunk.length; pending += chunk; timer ??= setTimeout(flush, LIVE_EVERY_MS); };
    let meta: { code?: number | null; truncated?: boolean; timedOut?: boolean; background?: boolean } = {};
    let output: string;
    try {
      output = await tool.run(args, { cwd: this.#o.cwd, ...(isConfined(this.#kind) ? { root: this.#o.cwd } : {}), signal: this.#abort.signal, emit: (e) => this.#emit(e.ev === "plan" ? { ...e, ...(this.#turnQid ? { qid: this.#turnQid } : {}), tool: call.id } : e), live, report: (m) => { meta = { ...meta, ...m }; }, allowPrivateNetwork: this.#o.allowPrivateNetwork, jobs: this.#jobs, ...(this.#o.backend ? { backend: this.#o.backend } : {}), ...(this.#o.recall ? { recall: this.#o.recall } : {}), ...(this.#o.search ? { search: this.#o.search } : {}), ...(this.#o.webProxy ? { webProxy: this.#o.webProxy } : {}), ...(this.#o.skills ? { skills: this.#o.skills } : {}), ...(this.#o.memory ? { memory: this.#o.memory } : {}), helper: (task, signal) => this.#delegate(call.id, task, signal) });
    } catch (e) { output = `Error: ${e instanceof Error ? e.message : String(e)}`; }
    clearTimeout(timer);
    flush();
    const stopped = this.#abort.signal.aborted || output.endsWith("[interrupted]");
    const outcome: ToolOutcome | undefined = meta.timedOut ? "timeout" : stopped ? "stopped" : meta.background ? "background" : undefined;
    const failed = output.startsWith("Error:") || outcome === "timeout" || outcome === "stopped";
    this.#emit({ ev: "tool", id: call.id, name: tool.name, status: failed ? "error" : "done", output, ms: Date.now() - t0, ...(meta.code !== undefined ? { code: meta.code } : {}), ...(meta.truncated ? { truncated: true as const } : {}), ...(outcome ? { outcome } : {}) });
    if (this.#o.hooks) for (const note of (await this.#o.hooks.post({ tool: tool.name, input: args, output }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    return output;
  }

  async #compact(manual = false, keep: number = KEEP_TAIL): Promise<boolean> {
    this.#emit({ ev: "phase", name: "compacting" });
    if (this.#o.hooks?.compact) for (const note of (await this.#o.hooks.compact({ manual }, this.#abort.signal).catch(() => ({ notes: [] as string[] }))).notes) this.#emit({ ev: "notice", msg: note });
    try {
      const next = await compactMessages(this.#messages, this.#provider, this.#abort.signal, keep);
      if (!next) { if (manual) this.#emit({ ev: "error", msg: "Nothing to compact yet — the conversation is still short." }); return false; }
      this.#messages = next;
      this.#lastContext = estimateTokens(next);
      this.#emit({ ev: "usage", ctx: this.#lastContext, win: this.#window, out: 0 });
      this.#save();
      return true;
    } catch (e) {
      this.#emit({ ev: "error", msg: `Couldn't compact: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    } finally { this.#emit({ ev: "phase", name: "" }); }
  }

  #beforeWrite(args: Record<string, unknown>): void {
    const target = typeof args.file_path === "string" ? resolve(this.#o.cwd, args.file_path) : undefined;
    if (!target) return;
    this.#written.add(target);
    if (this.#checkpoint) attempt(() => this.#o.checkpoints?.add(this.#checkpoint!, target));
  }

  #save(): void { try { this.#o.store?.save(this.sessionId, this.#messages); } catch { /* a full disk must not kill the turn */ } }
  #emit(event: EngineEvent): void { attempt(() => this.#o.emit(event)); }
}
