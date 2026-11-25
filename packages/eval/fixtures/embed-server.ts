/**
 * A server that turns text into vectors, as a stand-in for the one a person sets up for search by meaning (`start-web.ts embed-server.ts`).
 * Words that mean the same share a direction, as a real model's vectors do. It answers both shapes (`/v1/embeddings`, `/api/embed`) and
 * appends what it was asked to embed, one JSON line per request, to `.embed-log` in the workspace, so a check can see what was sent.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const CONCEPTS: Record<string, number> = {
  date: 0, dates: 0, format: 0, formatted: 0, timestamp: 0, timestamps: 0, iso: 0, "8601": 0,
  tabs: 1, indent: 1, indentation: 1, spaces: 1,
  deploy: 2, release: 2, ship: 2,
  test: 3, tests: 3, verify: 3,
};
const DIM = 8;
const vectorOf = (text: string): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const c = CONCEPTS[w];
    if (c !== undefined) v[c]! += 1;
    else v[4 + Number(Bun.hash(w) % 4n)]! += 0.05;
  }
  return v;
};

const log = join(process.env.BENCH_OUT ?? process.cwd(), ".embed-log");
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (await req.json()) as { input: string[] };
    appendFileSync(log, `${JSON.stringify({ path, input: body.input })}\n`);
    const vectors = body.input.map(vectorOf);
    if (path === "/api/embed") return Response.json({ embeddings: vectors });
    if (path === "/v1/embeddings") return Response.json({ data: vectors.map((embedding, index) => ({ index, embedding })) });
    return new Response("not found", { status: 404 });
  },
});
console.log(`ready ${server.port}`);
