import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { PROVIDERS } from "../src/presets.ts";
import { HubLink } from "../src/providers/link.ts";
import { endpointsScreen } from "../src/providers/endpoints.ts";
import { keysScreen } from "../src/providers/keys.ts";
import { localScreen } from "../src/providers/local.ts";
import { providersScreen } from "../src/providers/index.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";
import { scripted } from "./providers-helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

/** A real hub on a temporary computer, with the screens' link to it. `fetchFn` is what every outside address answers. */
function computer(fetchFn: typeof fetch, cloud = false) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_LOCAL_DIR: `${state}/local`, NAVVIED_GUEST_MODELS: "0" };
  const file = configPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", apiKey: "k", window: 1000 } } }), { mode: 0o600 });
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(cloud ? { sandboxed: true } : {}) } as never, fakeIO({ env, fetch: fetchFn }).io, { watch: false, import: false });
  const link: HubLink = new HubLink((cmd) => hub.command(JSON.stringify(cmd), () => undefined));
  const events: EngineEvent[] = [];
  hub.attach({ send: (line) => { const e = JSON.parse(String(line)) as EngineEvent; events.push(e); link.onEvent(e); } }, 0);
  return { link, file, events, saved: () => JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, { key?: string }>; endpoints?: Record<string, unknown>; models: Record<string, unknown> } };
}

const lists = (ids: string[], status = 200): typeof fetch => (async () => (status === 200 ? Response.json({ data: ids.map((id) => ({ id })) }) : new Response("no", { status }))) as unknown as typeof fetch;

describe("API keys against a real hub", () => {
  test("a key is saved on the computer, its models are listed, and choosing one makes a model of the configuration", async () => {
    const c = computer(lists(["alpha", "beta"]));
    const t = scripted(["DeepSeek", "DeepSeek key", "Save", "beta"], ["sk-live-1"]);
    expect(await keysScreen(t.kit(c.link))).toBe("switched");
    expect(c.saved().providers!.deepseek!.key).toBe("sk-live-1");
    expect(Object.keys(c.saved().models)).toContain("deepseek-beta");
    expect(JSON.stringify(t.shown)).not.toContain("sk-live-1");
    expect(JSON.stringify(c.events)).not.toContain("sk-live-1");
  });
  test("a key the service refuses is not saved, and what the hub said is on the list that follows", async () => {
    const c = computer(lists([], 401));
    const t = scripted(["DeepSeek", "DeepSeek key", "Save", undefined, undefined], ["sk-wrong"]);
    await keysScreen(t.kit(c.link));
    expect(c.saved().providers).toBeUndefined();
    const last = t.shown.filter((s) => s.title === "DeepSeek").at(-1)!;
    expect(last.frame.notice).toHaveLength(1);
    expect(last.frame.notice![0]).toMatch(/key/i);
    expect(t.shown.at(-1)!.items.find((i) => i.label.includes("DeepSeek"))!.label.startsWith("●")).toBe(false);
  });
  test("in a cloud session nothing can be saved, and the hub's sentence is on the list that follows", async () => {
    const c = computer(lists(["a"]), true);
    const t = scripted(["DeepSeek", "DeepSeek key", "Save", undefined, undefined], ["sk-cloud"]);
    await keysScreen(t.kit(c.link));
    expect(t.shown.filter((s) => s.title === "DeepSeek").at(-1)!.frame.notice![0]).toContain("Navvied Cloud");
    expect(c.saved().providers).toBeUndefined();
  });
  test("every service of the catalogue is a row", async () => {
    const c = computer(lists(["a"]));
    const t = scripted([undefined]);
    await keysScreen(t.kit(c.link));
    expect(t.shown[0]!.items).toHaveLength(PROVIDERS.length);
  });
});

describe("endpoints against a real hub", () => {
  test("an endpoint is made from what the server lists, saved with the style it answered in, and removed", async () => {
    const c = computer(lists(["srv-model"]));
    const t = scripted(["Add endpoint", "Name", "Endpoint URL", "Find models", "srv-model", "Save", "box", "Remove endpoint", undefined], ["box", "http://127.0.0.1:9/v1"]);
    await endpointsScreen(t.kit(c.link));
    expect(t.shown.some((s) => (s.frame.notice ?? []).includes("Saved."))).toBe(true);
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Removed."]);
    expect(c.saved().endpoints ?? {}).toEqual({});
  });
});

describe("local models against a real hub", () => {
  test("a computer with nothing installed offers to install the runtime and to search", async () => {
    const c = computer(lists([]));
    const t = scripted([undefined]);
    expect(await localScreen(t.kit(c.link))).toBe("back");
    expect(t.shown[0]!.items[0]!.label).toBe("Install runtime");
    expect(t.shown[0]!.items.map((i) => i.label)).toContain("Search Hugging Face");
    expect(t.shown[0]!.frame.body![0]).toBe("This machine");
    expect(t.shown[0]!.frame.body!.some((l) => l.startsWith("RAM"))).toBe(true);
  });
  test("in a cloud session the hub refuses and the screen says so", async () => {
    const c = computer(lists([]), true);
    const t = scripted([]);
    const kit = t.kit(c.link);
    expect(await localScreen(kit)).toBe("back");
    expect(kit.note).toHaveLength(1);
  });
});

describe("the Providers list", () => {
  test("it offers the three parts and ends when a model was chosen", async () => {
    const c = computer(lists(["alpha"]));
    const t = scripted(["API keys", "DeepSeek", "DeepSeek key", "Save", "alpha"], ["sk-x"]);
    expect(await providersScreen(t.kit(c.link))).toBe("switched");
    expect(t.shown[0]!.items.map((i) => i.label)).toEqual(["Accounts", "API keys", "Custom Endpoints", "Local Models"]);
  });
  test("going back from a part returns to the list, and back again leaves", async () => {
    const c = computer(lists([]));
    const t = scripted(["Custom Endpoints", undefined, undefined]);
    expect(await providersScreen(t.kit(c.link))).toBe("back");
    expect(t.shown.map((s) => s.title)).toEqual(["Providers", "Custom Endpoints", "Providers"]);
  });
});
