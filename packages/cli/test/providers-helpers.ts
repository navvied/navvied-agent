import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { HubLink } from "../src/providers/link.ts";
import { afterAll } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import { fakeIO, remove, tempDir } from "./helpers.ts";
import type { Choice, Frame, IO, Watch } from "../src/io.ts";
import { Kit } from "../src/providers/kit.ts";
import type { Link } from "../src/providers/link.ts";

export interface Shown { title: string; items: Choice[]; frame: Frame }
type Spec = { label?: string | number; before?: () => void; after?: (shown: Shown) => void };
type Pick = string | number | undefined | Spec;

/** The words of a screen as one string, for what must never appear in it. */
export const textOf = (s: Shown): string => [s.title, ...s.items.map((i) => `${i.label} ${i.hint ?? ""}`), ...(s.frame.heading ?? []), ...(s.frame.body ?? []), ...(s.frame.notice ?? [])].join("\n");

export class FakeLink implements Link {
  sent: object[] = [];
  #watchers = new Set<(e: EngineEvent) => void>();
  constructor(private reply: (cmd: Record<string, unknown>) => EngineEvent | string | undefined) {}
  async call<E extends EngineEvent["ev"]>(ev: E, cmd: object): Promise<Extract<EngineEvent, { ev: E }> | string> {
    this.sent.push(cmd);
    const got = this.reply(cmd as Record<string, unknown>);
    if (got === undefined) throw new Error(`no reply scripted for ${JSON.stringify(cmd)}`);
    if (typeof got !== "string") { if (got.ev !== ev) throw new Error(`asked for ${ev}, scripted ${got.ev}`); this.emit(got); }
    return got as never;
  }
  send(cmd: object): void { this.sent.push(cmd); }
  watch(fn: (e: EngineEvent) => void): () => void { this.#watchers.add(fn); return () => { this.#watchers.delete(fn); }; }
  emit(e: EngineEvent): void { for (const fn of this.#watchers) fn(e); }
  commands(name: string): Record<string, unknown>[] { return this.sent.filter((c) => (c as { cmd?: string }).cmd === name) as Record<string, unknown>[]; }
}

/**
 * A terminal that answers from a script: each list takes the next pick (a label, or a row number), each text field the next
 * typed value. A list asked past the end of the script goes back, so a test that forgot a step ends instead of looping.
 */
export function scripted(picks: Pick[], typed: (string | undefined)[] = []) {
  const shown: Shown[] = [];
  const queue = [...picks];
  const words = [...typed];
  const io = {
    color: false,
    choose: async (title: string, items: Choice[], _at?: number, frame: Frame = {}, watch?: Watch): Promise<number | "back" | undefined> => {
      const next = queue.shift();
      const spec: Spec = typeof next === "object" ? next : { label: next };
      spec.before?.();
      let items_ = items, frame_ = frame;
      if (watch) { const update = await watch.next(); if (update?.items) items_ = update.items; if (update?.frame) frame_ = update.frame; if (update?.auto !== undefined) { shown.push({ title, items: items_, frame: frame_ }); return update.auto; } }
      const here = { title, items: items_, frame: frame_ };
      shown.push(here);
      spec.after?.(here);
      const label = spec.label;
      if (label === undefined) return undefined;
      if (typeof label === "number") return label;
      const at = items_.findIndex((i) => i.label.trim() === label || i.label.replace(/^[● ]+/, "") === label);
      if (at < 0) throw new Error(`no row "${label}" in ${JSON.stringify(items_.map((i) => i.label))}`);
      return at;
    },
    text: async (title: string, _initial?: string, frame: Frame = {}) => { shown.push({ title, items: [], frame }); return words.shift(); },
    secret: async (title: string, frame: Frame = {}) => { shown.push({ title, items: [], frame }); return words.shift(); },
    work: async (title: string, frame: Frame, task: (c: { log(l: string): void; signal: AbortSignal }) => Promise<unknown>) => { shown.push({ title, items: [], frame }); return task({ log: () => undefined, signal: new AbortController().signal }); },
  } as unknown as IO;
  const said: string[] = [];
  const switched: boolean[] = [];
  const kit = (link: Link): Kit => new Kit(io, link, (t) => said.push(t), (h) => switched.push(h));
  return { io, shown, said, switched, kit };
}

export const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

export function computer(fetchFn: typeof fetch, cloud = false) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_LOCAL_DIR: `${state}/local`, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKey: "k", window: 1000 } } }), { mode: 0o600 });
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(cloud ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false, import: false });
  const link: HubLink = new HubLink((cmd) => hub.command(JSON.stringify(cmd), () => undefined));
  const events: EngineEvent[] = [];
  hub.attach({ send: (line) => { const e = JSON.parse(String(line)) as EngineEvent; events.push(e); link.onEvent(e); } }, 0);
  return { link, file, events, saved: () => JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, { key?: string }>; endpoints?: Record<string, unknown>; models: Record<string, unknown> } };
}

export const lists = (ids: string[], status = 200): typeof fetch => (async () => (status === 200 ? Response.json({ data: ids.map((id) => ({ id })) }) : new Response("no", { status }))) as unknown as typeof fetch;

