import type { Tool } from "../types.ts";
import { redact } from "../redact.ts";
import { clip, num, str } from "./util.ts";

const EARLIER = /\b(earlier|before|previous(ly)?|last time|yesterday|past (conversation|session|chat)s?|(other|another|old|older|last) (conversation|session|chat)s?|we (talked|discussed|decided|did)|you (told|said)|remember when|a while ago)\b/i;

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const WINDOW_CHARS = 6_000;
const WINDOW_MESSAGES = 12;
const WHO: Record<string, string> = { user: "User", assistant: "Assistant" };

export const recallTool: Tool = {
  name: "Recall",
  readOnly: true,
  // The words bring it in at once; in any other language it is named in the prompt and a call is run.
  offeredWhen: ({ recall, userText }) => recall === true && EARLIER.test(userText),
  description: "Search the user's earlier conversations. query: matches, with id and message number. id: read that conversation (around: a message number to read near). Nothing: the latest conversations.",
  parameters: { type: "object", properties: { query: { type: "string" }, id: { type: "string" }, around: { type: "number" }, limit: { type: "number" } } },
  fixArgs: (a) => ({ ...a, query: a.query ?? a.q ?? a.search, id: a.id ?? a.session ?? a.conversation, around: a.around ?? a.message }),
  title: (a) => (str(a.id) ? `Read earlier conversation ${str(a.id)}` : str(a.query) ? `Look through earlier conversations for: ${str(a.query).slice(0, 80)}` : "List recent conversations"),
  async run(a, ctx) {
    if (!ctx.recall) return "Error: earlier conversations are not available here.";
    const limit = Math.min(Math.max(1, Math.round(num(a.limit, 8))), 20);
    const id = str(a.id).trim(), query = str(a.query).trim();
    if (id) {
      const all = ctx.recall.read(id);
      if (!all) return `Error: there is no earlier conversation "${id}". Search first to get an id.`;
      // Message numbers count every item, so they match what a search reports.
      const items = all.flatMap((i, at) => (i.k !== "tool" && i.text.trim() ? [{ n: at + 1, ...i }] : []));
      if (!items.length) return "(that conversation is empty)";
      const around = Math.round(num(a.around, 0));
      const from = around > 0 ? Math.max(0, items.findLastIndex((i) => i.n <= around) - 3) : 0;
      const rows: string[] = [];
      let used = 0, end = from;
      while (end < items.length && rows.length < WINDOW_MESSAGES && used < WINDOW_CHARS) {
        const i = items[end++]!, row = `${i.n} ${WHO[i.k] ?? "Tool"}: ${clip(i.text, 1_500)}`;
        rows.push(row);
        used += row.length;
      }
      const next = items[end]?.n;
      return redact(`Messages ${items[from]!.n}-${items[end - 1]!.n}${next ? ` (more: around=${next})` : ""}:\n${rows.join("\n")}`);
    }
    if (query) {
      const hits = ctx.recall.search(query, limit);
      if (!hits.length) return `No earlier conversation mentions "${query}". Try other words, or fewer.`;
      return redact(hits.map((h) => `- ${h.title} (id ${h.id}, ${when(h.updated)}, message ${h.n})${h.snippet ? `: ${h.snippet}` : ""}`).join("\n"));
    }
    const recent = ctx.recall.recent(limit);
    return recent.length ? redact(recent.map((r) => `- ${r.title} (id ${r.id}, ${when(r.updated)})`).join("\n")) : "There are no earlier conversations yet.";
  },
};
