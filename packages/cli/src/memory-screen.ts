import type { EngineEvent } from "@navvied/protocol";
import type { Choice } from "./io.ts";
import type { Kit } from "./providers/kit.ts";

type Pending = Extract<EngineEvent, { ev: "memory.pending" }>;
type Notes = Extract<EngineEvent, { ev: "memory.notes" }>;
export interface HubRow extends Choice { run(): Promise<void> }

const WHERE = { message: "From your message", file: "From a file", web: "From a web page", tool: "From what a tool said" } as const;
const fromWhere = (i: Pending["items"][number]): string => `${WHERE[i.source]}${i.n !== undefined ? `, message ${i.n}` : ""}`;

export async function memoryHubRows(k: Kit): Promise<HubRow[]> {
  const mode = await k.link.call("memory.extract", { cmd: "memory.extract" });
  if (typeof mode === "string") return [];
  const pending = await k.link.call("memory.pending", { cmd: "memory.pending" });
  const on = mode.mode !== "off";
  const count = typeof pending === "string" ? 0 : pending.count;
  return [
    { label: `${on ? "on " : "off"}  Learn from conversations`, async run() { await k.link.call("memory.extract", { cmd: "memory.extract", mode: on ? "off" : "rules" }); } },
    { label: `Waiting for your OK${count ? `  ${count}` : ""}`, hint: !on ? "Learning is off. Nothing new is suggested." : count ? "Keep or dismiss what navvied suggests." : "Nothing is waiting.", async run() { if (on && count) await waiting(k); } },
    { label: "Remembered", hint: "What navvied keeps from your conversations.", async run() { await remembered(k); } },
  ];
}

async function waiting(k: Kit): Promise<void> {
  for (;;) {
    const got = await k.link.call("memory.pending", { cmd: "memory.pending" });
    if (typeof got === "string") { k.note.push(got); return; }
    if (!got.items.length) return;
    const picked = await k.choose("Waiting for your OK", "Waiting for your OK", got.items.map((i) => ({ label: i.text, hint: fromWhere(i) })));
    const item = picked === undefined ? undefined : got.items[picked];
    if (!item) return;
    const what = await k.choose(item.text, item.text, [{ label: "Keep" }, { label: "Dismiss" }], { body: [k.dim(fromWhere(item))] });
    if (what === 0 || what === 1) await k.link.call("memory.pending", { cmd: "memory.pending", action: what === 0 ? "accept" : "reject", id: item.id });
  }
}

async function remembered(k: Kit): Promise<void> {
  const got = await k.link.call("memory.notes", { cmd: "memory.list" }) as Notes | string;
  if (typeof got === "string") { k.note.push(got); return; }
  await k.choose("Remembered", "Remembered", got.items.length ? got.items.map((n) => ({ label: n.text })) : [{ label: "Back" }], { body: got.items.length ? [] : ["Nothing is remembered yet."] });
}
