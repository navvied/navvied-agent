import { afterAll, describe, expect, test } from "bun:test";
import { ProviderError } from "../src/index.ts";
import { fetchModel } from "../src/providers/net.ts";

const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
const quick = Bun.serve({ port: 0, fetch: () => new Response("ok") });
afterAll(() => { silent.stop(true); quick.stop(true); });

describe("waiting for a model to start answering", () => {
  test("a model that never answers ends the call with a sentence about reaching it", async () => {
    const err = await fetchModel(`http://127.0.0.1:${silent.port}/v1`, { method: "POST", signal: new AbortController().signal }, 150).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain(`127.0.0.1:${silent.port} can be reached`);
  });
  test("an answer in time is passed on untouched, and the wait does not limit the answer itself", async () => {
    const res = await fetchModel(`http://127.0.0.1:${quick.port}/`, { method: "POST", signal: new AbortController().signal }, 1000);
    expect(await res.text()).toBe("ok");
  });
  test("the person cancelling is not mistaken for a slow model", async () => {
    const stop = new AbortController();
    const pending = fetchModel(`http://127.0.0.1:${silent.port}/v1`, { method: "POST", signal: stop.signal }, 5000).catch((e: unknown) => e);
    setTimeout(() => stop.abort(), 30);
    const err = await pending;
    expect(err).not.toBeInstanceOf(ProviderError);
  });
});
