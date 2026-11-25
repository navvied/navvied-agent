import { describe, expect, test } from "bun:test";
import type { Provider } from "@navvied/engine";
import type { ResolvedModel } from "../src/config.ts";
import { LiveProvider } from "../src/live-provider.ts";

const model = (apiKey: string, window = 1000): ResolvedModel => ({ name: "m", window, small: false, provider: { baseUrl: "https://x.test", model: "m", apiKey } });
const reply = { content: "ok", calls: [], finish: "stop" };

function fixture() {
  let now: { ok: true; value: ResolvedModel } | { ok: false; error: string } = { ok: true, value: model("k1") };
  const built: string[] = [];
  const seen: string[] = [];
  const live = new LiveProvider(() => now, (m) => { built.push(m.provider!.apiKey!); return { stream: async () => { seen.push(m.provider!.apiKey!); return reply; }, complete: async () => { seen.push(m.provider!.apiKey!); return "done"; } } satisfies Provider; }, model("k1"));
  const ask = () => live.stream({ system: "s", messages: [], tools: [] }, new AbortController().signal, { text() {}, thought() {}, toolStarted() {} });
  return { live, ask, seen, built, set: (n: typeof now) => { now = n; } };
}

describe("a model resolved at every request", () => {
  test("the same key builds the service once, and a new key is the one the next request carries", async () => {
    const f = fixture();
    await f.ask(); await f.ask();
    expect(f.built).toEqual(["k1"]);
    f.set({ ok: true, value: model("k2") });
    await f.ask();
    await f.live.complete("s", "u", new AbortController().signal);
    expect(f.seen).toEqual(["k1", "k1", "k2", "k2"]);
    expect(f.built).toEqual(["k1", "k2"]);
  });

  test("when it can no longer be resolved the request is refused in the words of the refusal, with the status that is not tried again, and nothing is sent", async () => {
    const f = fixture();
    await f.ask();
    f.set({ ok: false, error: "Add a key for X first." });
    const failed = await f.ask().catch((e: Error & { status?: number }) => e);
    expect(failed).toMatchObject({ message: "Add a key for X first.", status: 401 });
    expect(await f.live.complete("s", "u", new AbortController().signal).catch((e: Error) => e.message)).toBe("Add a key for X first.");
    expect(f.seen).toEqual(["k1"]);
    f.set({ ok: true, value: model("k3") });
    await f.ask();
    expect(f.seen).toEqual(["k1", "k3"]);
  });

  test("it reads PDFs when the model does", () => {
    const f = new LiveProvider(() => ({ ok: true, value: model("k") }), () => ({ stream: async () => reply, complete: async () => "" }), { ...model("k"), pdf: true });
    expect(f.readsPdf).toBe(true);
  });
});
