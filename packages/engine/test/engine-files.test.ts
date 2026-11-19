import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatCompletionsProvider, toWire as chatWire } from "../src/providers/chat-completions.ts";
import { FallbackProvider } from "../src/providers/fallback.ts";
import { MessagesApiProvider, toWire as messagesWire } from "../src/providers/messages-api.ts";
import { toInput } from "../src/providers/responses-api.ts";
import type { Message, Part } from "../src/types.ts";
import { PNG, b64, docxFile, pdf } from "./make-files.ts";
import { cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll);

const attachments = mkdtempSync(join(tmpdir(), "navvied-attachments-test-"));
const send = (name: string, bytes: Buffer | string, mime = "application/octet-stream") => ({ name, mime, data: b64(bytes) });
const lastUser = (r: { provider: { requests: { messages: Message[] }[] } }): Part[] => {
  const m = r.provider.requests.at(-1)!.messages.filter((x) => x.role === "user").at(-1)!;
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];
};
const textOf = (parts: Part[]) => parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("files on a prompt", () => {
  test("they are saved in the session's folder, the model is told, and every window is told what each file is (no content)", async () => {
    const r = rig(() => ({ text: "read it" }), { attachments });
    const pdfBytes = pdf([{ content: "BT /F1 12 Tf (Invoice total 42) Tj ET" }]);
    await r.turn(prompt("what is the total?", { qid: "q1", files: [send("invoice.pdf", pdfBytes, "application/pdf"), send("movie.mp4", "\0\0\0\x18ftypisom\0\0\0\0")] }));
    const saved = join(attachments, r.engine.sessionId, "invoice.pdf");
    expect(readFileSync(saved).equals(pdfBytes)).toBe(true);
    expect(existsSync(join(attachments, r.engine.sessionId, "movie.mp4"))).toBe(false);
    const told = textOf(lastUser(r));
    expect(told).toStartWith("what is the total?\n\nattached: invoice.pdf (1 page) saved at ");
    expect(told).toContain(`${saved}\n--- Page 1 ---\nInvoice total 42`);
    expect(told).toContain("not attached: movie.mp4. Video files are not supported.");
    expect(r.of("user")).toEqual([{ ev: "user", qid: "q1", text: "what is the total?", files: [{ name: "invoice.pdf", kind: "pdf", pages: 1 }, { name: "movie.mp4", kind: "refused", note: "Video files are not supported." }] }]);
    expect(JSON.stringify(r.events)).not.toContain("Invoice total 42");
    r.cleanup();
  });

  test("a prompt of a file alone is a prompt, and a Word file is read", async () => {
    const r = rig(() => ({ text: "ok" }), { attachments });
    await r.turn(prompt("", { qid: "q", files: [send("plan.docx", docxFile("Ship on Friday"))] }));
    expect(textOf(lastUser(r))).toStartWith("attached: plan.docx (document) saved at ");
    expect(textOf(lastUser(r))).toContain("Ship on Friday");
    r.cleanup();
  });

  test("a file sent while the agent is busy is announced as queued with what it is, and reaches the model when taken", async () => {
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : req.messages.length > 2 ? { text: "second" } : { calls: [{ name: "Bash", args: { command: "sleep 1" } }] }), { attachments });
    r.send(prompt("start", { qid: "a" }));
    await until(() => r.of("taken").length === 1);
    r.send(prompt("see this", { qid: "b", files: [send("n.txt", "note text")] }));
    await r.engine.idle();
    expect(r.of("queued")).toEqual([{ ev: "queued", qid: "b", text: "see this", files: [{ name: "n.txt", kind: "text" }] }]);
    expect(r.of("user").find((e) => e.qid === "b")?.files).toEqual([{ name: "n.txt", kind: "text" }]);
    expect(JSON.stringify(r.provider.requests.at(-1)!.messages)).toContain("note text");
    r.cleanup();
  });

  test("the original PDF is sent along only when the provider reads PDFs", async () => {
    const bytes = pdf([{ content: "BT (x) Tj ET" }]);
    for (const reads of [true, false]) {
      const r = rig(() => ({ text: "ok" }), { attachments });
      (r.provider as unknown as { readsPdf: boolean }).readsPdf = reads;
      await r.turn(prompt("look", { qid: "q", files: [send("a.pdf", bytes)] }));
      expect(lastUser(r).filter((p) => p.type === "file")).toEqual(reads ? [{ type: "file", name: "a.pdf", mime: "application/pdf", data: b64(bytes) }] : []);
      r.cleanup();
    }
  });

  test("a conversation held to its own folder keeps the files inside it, where it may read them", async () => {
    const r = rig(() => ({ text: "ok" }), { attachments, kind: "chat" });
    await r.turn(prompt("here", { qid: "q", files: [send("n.txt", "chat note")] }));
    expect(readFileSync(join(r.dir, "attachments", "n.txt"), "utf8")).toBe("chat note");
    expect(textOf(lastUser(r))).toContain(`saved at ${join(r.dir, "attachments", "n.txt")}`);
    r.cleanup();
  });
});

describe("a model that cannot see pictures", () => {
  test("pictures are not sent, the model and the screen are told, and caps says so", async () => {
    const r = rig(() => ({ text: "ok" }), { attachments, vision: false });
    expect(r.of("caps").at(-1)?.vision).toBe(false);
    await r.turn(prompt("what is this?", { qid: "q", images: [{ mime: "image/png", data: b64(PNG) }], files: [send("p.png", PNG), send("n.txt", "hi")] }));
    expect(lastUser(r).some((p) => p.type === "image")).toBe(false);
    expect(textOf(lastUser(r))).toContain("A picture was attached but not shown to you: this model cannot see pictures.");
    expect(textOf(lastUser(r))).toContain("It is not shown to you: this model cannot see pictures.");
    expect(r.of("notice").map((e) => e.msg)).toEqual(["This model cannot see pictures, so they were not sent."]);
    expect(r.of("user")[0]).toEqual({ ev: "user", qid: "q", text: "what is this?", files: [{ name: "p.png", kind: "image", note: "this model cannot see pictures" }, { name: "n.txt", kind: "text" }] });
    r.cleanup();
  });

  test("caps tells a window whether to offer pictures: false when known, nothing when not", async () => {
    const known = rig(() => ({ text: "ok" }), { vision: false });
    await known.turn(prompt("hi"));
    expect(known.of("caps").some((e) => e.vision === false)).toBe(true);
    known.cleanup();
    const unknown = rig(() => ({ text: "ok" }));
    await unknown.turn(prompt("hi"));
    expect(unknown.of("caps").every((e) => e.vision === undefined)).toBe(true);
    unknown.cleanup();
    const sees = rig(() => ({ text: "ok" }), { vision: true });
    await sees.turn(prompt("hi", { images: [{ mime: "image/png", data: b64(PNG) }] }));
    expect(lastUser(sees).some((p) => p.type === "image")).toBe(true);
    sees.cleanup();
  });

  test("when the model is not known and the service refuses the picture, the picture leaves the conversation and the message is the plain one", async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? { fail: "400: image input is not supported by this model" } : { text: "fine" }), { attachments });
    await r.turn(prompt("look", { qid: "q", images: [{ mime: "image/png", data: b64(PNG) }] }));
    expect(r.of("error").map((e) => e.msg)).toEqual(["This model cannot see pictures, so they were not sent."]);
    expect(r.of("caps").at(-1)?.vision).toBe(false);
    await r.turn(prompt("again", { qid: "q2", images: [{ mime: "image/png", data: b64(PNG) }] }));
    expect(r.provider.requests.at(-1)!.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image"))).toBe(false);
    expect(r.of("error")).toHaveLength(1);
    expect(JSON.stringify(r.provider.requests.at(-1)!.messages)).toContain("a picture was attached here; this model cannot see pictures");
    r.cleanup();
  });

  test("an error that is about something else is shown as it is", async () => {
    const r = rig(() => ({ fail: "429: too many requests" }), { attachments });
    await r.turn(prompt("look", { images: [{ mime: "image/png", data: b64(PNG) }] }));
    expect(r.of("error").map((e) => e.msg)).toEqual(["429: too many requests"]);
    expect(r.of("caps").at(-1)?.vision).toBeUndefined();
    r.cleanup();
  });
});

describe("what each kind of service is given", () => {
  const pdfPart: Part = { type: "file", name: "a.pdf", mime: "application/pdf", data: "QQ==" };
  const message: Message = { role: "user", content: [{ type: "text", text: "t" }, pdfPart, { type: "image", mime: "image/png", data: "QQ==" }] };

  test("chat completions has no place for a PDF: the text is already in the message, so it is left out", () => {
    expect(chatWire(message)).toEqual({ role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }] });
    expect((new ChatCompletionsProvider({ baseUrl: "http://x", model: "m" }) as { readsPdf?: boolean }).readsPdf).toBeUndefined();
  });

  test("the messages API gets a document block, and says it reads PDFs only when told", () => {
    expect(messagesWire([message])[0]!.content).toEqual([{ type: "text", text: "t" }, { type: "document", title: "a.pdf", source: { type: "base64", media_type: "application/pdf", data: "QQ==" } }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }]);
    expect(new MessagesApiProvider({ baseUrl: "http://x", model: "m" }).readsPdf).toBe(false);
    expect(new MessagesApiProvider({ baseUrl: "http://x", model: "m", readsPdf: true }).readsPdf).toBe(true);
  });

  test("the responses API gets an input_file", () => {
    expect(toInput([message])).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "t" }, { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,QQ==" }, { type: "input_image", image_url: "data:image/png;base64,QQ==" }] }]);
  });

  test("a chain of models reads PDFs as its first model does", () => {
    const reads = new MessagesApiProvider({ baseUrl: "http://x", model: "m", readsPdf: true });
    const plain = new ChatCompletionsProvider({ baseUrl: "http://x", model: "m" });
    expect(new FallbackProvider([{ name: "a", provider: reads }, { name: "b", provider: plain }]).readsPdf).toBe(true);
    expect(new FallbackProvider([{ name: "b", provider: plain }, { name: "a", provider: reads }]).readsPdf).toBe(false);
  });
});
