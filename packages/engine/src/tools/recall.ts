import type { Tool } from "../types.ts";
import { clip, num, str } from "./util.ts";

/** Asked about an earlier conversation: only then is the tool offered, so a small model is not given one more thing to choose from every turn. */
const EARLIER = /\b(earlier|before|previous(ly)?|last time|yesterday|past (conversation|session|chat)s?|(other|another|old|older|last) (conversation|session|chat)s?|we (talked|discussed|decided|did)|you (told|said)|remember when|a while ago)\b/i;

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const recallTool: Tool = {
  name: "Recall",
  readOnly: true,
  offeredWhen: ({ userText, recall }) => recall === true && EARLIER.test(userText),
  description: "Look through the user's earlier conversations. With query: the conversations that mention it (title, date, a snippet, and an id). With id: what was said in that conversation. Use it when the user refers to something from before.",
  parameters: { type: "object", properties: { query: { type: "string", description: "words to look for" }, id: { type: "string", description: "a conversation id from an earlier search, to read it" }, limit: { type: "number", description: "how many to list (default 8)" } } },
  title: (a) => (str(a.id) ? `Read earlier conversation ${str(a.id)}` : `Look through earlier conversations for: ${str(a.query).slice(0, 80)}`),
  async run(a, ctx) {
    if (!ctx.recall) return "Error: earlier conversations are not available here.";
    const id = str(a.id).trim();
    if (id) {
      const items = ctx.recall.read(id);
      if (!items) return `Error: there is no earlier conversation "${id}". Search first to get an id.`;
      const text = items.map((i) => `${i.k === "user" ? "User" : i.k === "assistant" ? "Assistant" : "Tool"}: ${i.text}`).join("\n");
      return clip(text || "(that conversation is empty)", 12_000);
    }
    const query = str(a.query).trim();
    if (!query) return "Error: give words to look for (query) or a conversation id (id).";
    const hits = ctx.recall.search(query, Math.min(Math.max(1, num(a.limit, 8)), 20));
    if (!hits.length) return `No earlier conversation mentions "${query}".`;
    return hits.map((h) => `- ${h.title} (id ${h.id}, ${when(h.updated)})${h.snippet ? `: ${h.snippet}` : ""}`).join("\n");
  },
};
