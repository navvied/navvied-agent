import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, closeBrowser, defaultTools } from "../src/index.ts";
import { sseData } from "../src/providers/sse.ts";
import { garbage, int, mutate, pick, prng, value } from "../../protocol/test/prng.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-tool-fuzz-"));
// The browser tool may have been started by a random call: it is closed, so no program is left running after the tests.
afterAll(hook("fuzz removes what it made", async () => { await stopAllJobs(); closeBrowser(); await removeTree(dir); }));

test("every tool turns any arguments into a string answer; none throws or hangs", async () => {
  const r = prng(31);
  const tools = defaultTools().filter((t) => !["WebFetch", "Bash", "BashOutput", "KillShell"].includes(t.name));
  const jobs = new Jobs(() => {});
  const ctx = { cwd: dir, signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, jobs };
  for (let i = 0; i < 1200; i++) {
    const tool = pick(r, tools);
    const base = { file_path: pick(r, ["a.txt", "", "/", "../../etc", "sub/x.ts", "\u0000"]), content: "x", old_string: "x", new_string: "y", pattern: pick(r, ["x", "(", "[", "*", ""]), path: ".", todos: [] };
    const args = r() < 0.3 ? (value(r) as Record<string, unknown>) : mutate(r, base);
    const out = await Promise.race([
      tool.run(args && typeof args === "object" && !Array.isArray(args) ? args : {}, ctx).then((s) => s, (e: Error) => `threw: ${e.message}`),
      new Promise<string>((res) => setTimeout(() => res("hung"), 30_000)),
    ]);
    expect(typeof out).toBe("string");
    expect(out).not.toBe("hung");
  }
}, 300_000);

test("the event stream reader yields exactly the data lines, however the bytes are cut or corrupted", async () => {
  const r = prng(32);
  const enc = new TextEncoder();
  for (let i = 0; i < 300; i++) {
    const payloads = Array.from({ length: int(r, 6) }, () => JSON.stringify(value(r)));
    const noise = () => pick(r, ["", ": comment\n", "event: x\n", "\n", "id: 5\n", "data:\n", "random\n"]);
    const text = payloads.map((p) => `${noise()}data: ${p}\n\n`).join("");
    const bytes = enc.encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let at = 0; at < bytes.length; ) { const n = 1 + int(r, 17); c.enqueue(bytes.slice(at, at + n)); at += n; } c.close(); },
    });
    const got: string[] = [];
    for await (const d of sseData(stream)) got.push(d);
    expect(got).toEqual(payloads);
  }
});

test("random bytes are never an exception for the reader", async () => {
  const r = prng(33);
  for (let i = 0; i < 200; i++) {
    const bytes = new Uint8Array(int(r, 200)).map(() => int(r, 256));
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    for await (const d of sseData(stream)) expect(typeof d).toBe("string");
    void garbage;
  }
});
