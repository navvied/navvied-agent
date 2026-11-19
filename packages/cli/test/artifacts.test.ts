import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactBook, artifactId, mimeOf } from "../src/artifacts.ts";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));

type Ev = { ev: string; kind?: string; [k: string]: unknown };

/** A model that writes a file on its first reply and says it is done on its second. */
function writer(file: string, content: string) {
  const enc = new TextEncoder();
  const chunk = (d: object, f?: string) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: f ?? null }] })}\n\n`;
  const sse = (t: string) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`${t}data: [DONE]\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  return Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as { messages: { role: string }[]; stream?: boolean };
    if (!body.stream) return Response.json({ choices: [{ message: { content: "S" } }] });
    if (body.messages.some((m) => m.role === "tool")) return sse(chunk({ content: "Saved it." }) + chunk({}, "stop"));
    return sse(chunk({ tool_calls: [{ index: 0, id: "call_w", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: file, content }) } }] }) + chunk({}, "tool_calls"));
  } });
}

function open(file: string, content: string) {
  const model = writer(file, content);
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: `http://127.0.0.1:${model.port}/v1`, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const stop = async (): Promise<void> => { await hub.stop(); model.stop(true); };
  return { got, send, stop, work };
}

describe("the files a conversation wrote", () => {
  test("a chat's file is listed under its conversation with a name, size and kind, and can be read to show; it is named by an id, never a path", async () => {
    const { got, send, stop } = open("notes.md", "# Trip plan\n\nDay one: Ubud.");
    send({ cmd: "prompt", text: "write my trip notes", qid: "c1", kind: "chat" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === "chat"));
    send({ cmd: "artifacts", kind: "chat" });
    await until(() => got.some((e) => e.ev === "artifacts" && e.kind === "chat"));
    const items = (got.find((e) => e.ev === "artifacts" && e.kind === "chat") as unknown as { items: { id: string; conversation: string; name: string; bytes: number; mime: string; path?: string }[] }).items;
    expect(items.map((i) => i.name)).toEqual(["notes.md"]);
    expect(items[0]).toMatchObject({ mime: "text/markdown", bytes: Buffer.byteLength("# Trip plan\n\nDay one: Ubud.") });
    const session = (got.find((e) => e.ev === "session" && e.kind === "chat") as unknown as { id: string }).id;
    expect(items[0]!.conversation).toBe(session);

    send({ cmd: "artifact.read", id: items[0]!.id, kind: "chat" });
    await until(() => got.some((e) => e.ev === "artifact"));
    expect(got.find((e) => e.ev === "artifact")).toMatchObject({ name: "notes.md", mime: "text/markdown", text: "# Trip plan\n\nDay one: Ubud." });
    // A path is not an id.
    send({ cmd: "artifact.read", id: "/etc/passwd", kind: "chat" });
    send({ cmd: "artifact.read", id: items[0]!.id.replace(/./, "z"), kind: "chat" });
    await until(() => got.filter((e) => e.ev === "error").length >= 2);
    expect(got.filter((e) => e.ev === "error").map((e) => e.msg)).toEqual(["That file is gone.", "That file is gone."]);
    // Asking for one conversation's files only.
    send({ cmd: "artifacts", id: "another-conversation", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "artifacts").length >= 2);
    expect((got.filter((e) => e.ev === "artifacts").at(-1) as unknown as { items: unknown[] }).items).toEqual([]);
    await stop();
  });

  test("an agent's file is listed for the agent, and a chat does not see it", async () => {
    const { got, send, stop, work } = open(join(tempDir(), "x").replace(/x$/, "report.csv"), "a,b\n1,2\n");
    dirs.push(work);
    send({ cmd: "prompt", text: "make a report", qid: "a1" });
    await until(() => got.some((e) => e.ev === "done" && e.kind === undefined));
    send({ cmd: "artifacts" });
    send({ cmd: "artifacts", kind: "chat" });
    await until(() => got.filter((e) => e.ev === "artifacts").length >= 2);
    const agent = (got.find((e) => e.ev === "artifacts" && e.kind === undefined) as unknown as { items: { name: string; mime: string }[] }).items;
    const chat = (got.find((e) => e.ev === "artifacts" && e.kind === "chat") as unknown as { items: unknown[] }).items;
    expect(agent).toMatchObject([{ name: "report.csv", mime: "text/csv" }]);
    expect(chat).toEqual([]);
    await stop();
  });
});

describe("what can be shown", () => {
  test("text and pictures are shown, big text is cut, anything else is only listed", () => {
    const dir = tempDir(); dirs.push(dir);
    const book = new ArtifactBook(join(dir, "artifacts.json"));
    mkdirSync(join(dir, "files"));
    const f = (name: string, data: string | Buffer): string => { const p = join(dir, "files", name); writeFileSync(p, data); book.add("conv", p); return artifactId("conv", p); };
    const text = f("a.txt", "hello");
    const big = f("big.json", "x".repeat(1_200_000));
    const png = f("pic.png", Buffer.from([137, 80, 78, 71]));
    const bin = f("data.bin", Buffer.from([1, 2, 3]));
    const exe = f("tool.exe", "MZ");
    expect(book.read(text)).toMatchObject({ text: "hello" });
    const cut = book.read(big) as { text: string; truncated?: boolean };
    expect(cut.text.length).toBe(1_000_000);
    expect(cut.truncated).toBe(true);
    expect(book.read(png)).toMatchObject({ data: Buffer.from([137, 80, 78, 71]).toString("base64") });
    expect(book.read(bin)).toEqual({ error: "This kind of file cannot be shown here." });
    expect(book.read(exe)).toEqual({ error: "This kind of file cannot be shown here." });
    expect(book.list().map((a) => a.mime).sort()).toEqual(["application/json", "application/octet-stream", "application/octet-stream", "image/png", "text/plain"]);
    expect(mimeOf("x.PNG")).toBe("image/png");
    expect(book.list("nobody")).toEqual([]);
  });
});
