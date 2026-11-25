import { afterAll, describe, expect, test } from "bun:test";
import { startMeter, type MeterLimits } from "../src/index.ts";

const request = { model: "m", stream: false, messages: [{ role: "user", content: "hello" }] };
let answer: () => Response = () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
let asked = 0;
const model = Bun.serve({ port: 0, async fetch(req) { await req.text(); asked += 1; return answer(); } });
afterAll(() => model.stop(true));

function meterWith(limits: MeterLimits) {
  const meter = startMeter(`http://127.0.0.1:${model.port}/v1`, limits);
  const post = () => fetch(`${meter.url("r")}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  return { meter, post };
}

describe("the counter keeps to the service's limits", () => {
  test("requests are spaced to the rate, and the wait is told apart from the model's time", async () => {
    const { meter, post } = meterWith({ perMinute: 1200 });
    const before = Date.now();
    for (let i = 0; i < 3; i++) await (await post()).text();
    expect(Date.now() - before).toBeGreaterThanOrEqual(95);
    const hits = await meter.take("r");
    expect(hits.map((h) => h.status)).toEqual([200, 200, 200]);
    expect(hits[0]!.waitedMs).toBe(0);
    expect(hits[1]!.waitedMs).toBeGreaterThanOrEqual(40);
    expect(hits[2]!.waitedMs).toBeGreaterThanOrEqual(40);
    meter.stop();
  });

  test("an answer of too many requests is waited out and the request sent again, so the agent never sees it", async () => {
    asked = 0;
    let first = true;
    answer = () => { if (first) { first = false; return new Response("slow down", { status: 429, headers: { "retry-after": "0.1" } }); } return Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }); };
    const { meter, post } = meterWith({ perMinute: 1200 });
    const res = await post();
    expect(res.status).toBe(200);
    expect(asked).toBe(2);
    const [hit] = await meter.take("r");
    expect(hit).toMatchObject({ status: 200, inTokens: 10, outTokens: 5 });
    expect(hit!.waitedMs).toBeGreaterThanOrEqual(100);
    meter.stop();
  });

  test("without a rate to keep, an answer of too many requests goes through as it is", async () => {
    answer = () => new Response("slow down", { status: 429 });
    const { meter, post } = meterWith({});
    expect((await post()).status).toBe(429);
    meter.stop();
  });

  test("the token limit is hard: the request that would pass it is not sent, and the meter says it stopped", async () => {
    asked = 0;
    answer = () => Response.json({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 100 } });
    const { meter, post } = meterWith({ maxTokens: 210 });
    expect((await post()).status).toBe(200);
    expect(meter.spent()).toBe(200);
    expect(meter.exhausted()).toBe(false);
    const refused = await post();
    expect(refused.status).toBe(402);
    expect(await refused.text()).toContain("limit");
    expect(asked).toBe(1);
    expect(meter.exhausted()).toBe(true);
    expect(meter.spent()).toBe(200);
    meter.stop();
  });
});
