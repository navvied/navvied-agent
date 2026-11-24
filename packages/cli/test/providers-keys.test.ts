import { describe, expect, test } from "bun:test";
import type { EngineEvent, ProviderSaved } from "@navvied/protocol";
import type { ProviderEntry } from "../src/providers.ts";
import { keysScreen, pageRows, providerRows } from "../src/providers/keys.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

const ENTRIES: ProviderEntry[] = [
  { id: "plain", name: "Plain Service", base: "https://plain.example/v1", getKey: "https://plain.example/keys" },
  { id: "local", name: "Local Server", base: "http://localhost:1/v1", keyOptional: true },
  { id: "zoned", name: "Zoned", regions: [{ id: "eu", label: "Europe", base: "https://eu.example", keyUrl: "https://eu.example/keys" }, { id: "us", label: "America", base: "https://us.example" }], keyNote: "A key works in one region." },
  { id: "extra", name: "Extra", base: "https://extra.example", fields: [{ id: "org", label: "Organization ID" }, { id: "res", label: "Resource name", ph: "YOUR-RESOURCE", required: true }, { id: "tok", label: "Token", secret: true }] },
  { id: "file", name: "File Cloud", base: "https://file.example", adc: { places: [] } as never, fields: [{ id: "project", label: "Project ID", required: true }] },
];
const providers = (items: ProviderSaved[]): EngineEvent => ({ ev: "providers", items });
const models = (id: string, ids: string[]): EngineEvent => ({ ev: "provider.models", id, models: ids });

describe("the list of services", () => {
  test("a dot marks the services that have a key; nothing else is said under them", () => {
    expect(providerRows(ENTRIES, [{ id: "zoned", key: true, region: "eu" }]).map((r) => [r.label, r.hint])).toEqual([
      ["  Plain Service", undefined], ["  Local Server", undefined], ["● Zoned", undefined], ["  Extra", undefined], ["  File Cloud", undefined],
    ]);
  });
  test("a service that signs in with a file of this computer has its dot once that file is found", () => {
    expect(providerRows(ENTRIES, [{ id: "file", key: false, credential: true }])[4]!.label).toBe("● File Cloud");
    expect(providerRows(ENTRIES, [{ id: "file", key: false, credential: false }])[4]!.label).toBe("  File Cloud");
  });
});

describe("the page of one service", () => {
  test("region, fields, key, another address, Save: the order of the page", () => {
    const rows = pageRows(ENTRIES[2]!, undefined, { fields: {} });
    expect(rows.map((r) => [r.label, r.hint])).toEqual([["Region", "Europe"], ["Zoned key", "Paste Zoned key"], ["Zoned base URL override", "https://eu.example"], ["Save", undefined]]);
  });
  test("fields show their example until filled, a secret one only says it is saved, and Remove is there once a key is", () => {
    const rows = pageRows(ENTRIES[3]!, { id: "extra", key: true, fields: { org: "o1", tok: "x" } }, { fields: {} });
    expect(rows.map((r) => [r.label, r.hint])).toEqual([["Organization ID", "o1"], ["Resource name", "YOUR-RESOURCE"], ["Token", "Saved"], ["Extra key", "Saved"], ["Extra base URL override", "https://extra.example"], ["Save", undefined], ["Remove", undefined]]);
  });
  test("a key just pasted is shown as dots; a service with a file to sign in has no key row", () => {
    expect(pageRows(ENTRIES[0]!, undefined, { key: "sk-1", fields: {} })[0]!.hint).toBe("••••••••");
    expect(pageRows(ENTRIES[4]!, { id: "file", key: false, credential: true }, { fields: {} }).map((r) => r.label)).toEqual(["Project ID", "File Cloud base URL override", "Save", "Remove"]);
  });
});

describe("adding a key", () => {
  test("region, then the key (hidden), then Save: kept once, the service is asked for its models, and the one chosen is used", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "zoned", key: true, region: "us" }]) : c.cmd === "provider.models" ? models("zoned", ["big", "small"]) : undefined);
    const t = scripted(["Zoned", "Region", "America", "Zoned key", "Save", "small"], ["sk-secret-1234"]);
    expect(await keysScreen(t.kit(link), ENTRIES)).toBe("switched");
    expect(link.commands("provider.save")).toEqual([{ cmd: "provider.save", id: "zoned", key: "sk-secret-1234", region: "us" }]);
    expect(link.commands("provider.use")).toEqual([{ cmd: "provider.use", id: "zoned", model: "small" }]);
    expect(t.switched).toEqual([true]);
    expect(JSON.stringify(t.shown)).not.toContain("sk-secret-1234");
  });
  test("the page names where a key is made, for the region chosen, and the service's own note", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : undefined);
    const t = scripted(["Zoned", undefined, undefined]);
    await keysScreen(t.kit(link), ENTRIES);
    expect(t.shown[1]!.frame.body).toEqual(["A key works in one region.", "Get a key: https://eu.example/keys"]);
  });
  test("a key the service refuses is not kept: the page says why and the key is still to be pasted again", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? "The provider did not accept the key." : undefined);
    const t = scripted(["Plain Service", "Plain Service key", "Save", undefined, undefined], ["sk-wrong"]);
    await keysScreen(t.kit(link), ENTRIES);
    const after = t.shown.filter((s) => s.title === "Plain Service").at(-1)!;
    expect(after.frame.notice).toEqual(["The provider did not accept the key."]);
    expect(link.commands("provider.models")).toEqual([]);
    expect(link.commands("provider.use")).toEqual([]);
  });
  test("fields are typed and sent with the key; one left alone is not sent", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "extra", key: true }]) : c.cmd === "provider.models" ? models("extra", ["m"]) : undefined);
    const t = scripted(["Extra", "Resource name", "Token", "Extra key", "Save", "m"], ["R1", "tk", "sk-key"]);
    await keysScreen(t.kit(link), ENTRIES);
    expect(link.commands("provider.save")[0]).toEqual({ cmd: "provider.save", id: "extra", key: "sk-key", fields: { res: "R1", tok: "tk" } });
    expect(t.shown.find((s) => s.title === "Resource name")!.frame.body).toEqual(["YOUR-RESOURCE"]);
    expect(JSON.stringify(t.shown)).not.toContain('"tk"');
  });
  test("another address is typed and sent, empty to take it away", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([{ id: "plain", key: true, base: "https://gw.example/v1" }]) : c.cmd === "provider.save" ? providers([{ id: "plain", key: true }]) : c.cmd === "provider.models" ? models("plain", ["x"]) : undefined);
    const t = scripted(["Plain Service", "Plain Service base URL override", "Save", "x"], [""]);
    await keysScreen(t.kit(link), ENTRIES);
    expect(link.commands("provider.save")).toEqual([{ cmd: "provider.save", id: "plain", base: "" }]);
    expect(t.shown.find((s) => s.title === "Plain Service")!.items[1]!.hint).toBe("https://gw.example/v1");
  });
  test("a service that needs no key is saved with nothing and goes to its models", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "local", key: false }]) : c.cmd === "provider.models" ? models("local", ["m1"]) : undefined);
    const t = scripted(["Local Server", "Save", "m1"]);
    expect(await keysScreen(t.kit(link), ENTRIES)).toBe("switched");
    expect(link.commands("provider.save")).toEqual([{ cmd: "provider.save", id: "local" }]);
  });
  test("a service that signs in with a file asks for its fields only, and the model is typed because it has no list", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "file", key: false, credential: true, fields: { project: "p1" } }]) : undefined);
    const t = scripted(["File Cloud", "Project ID", "Save"], ["p1", "the-model"]);
    expect(await keysScreen(t.kit(link), ENTRIES)).toBe("switched");
    expect(link.commands("provider.save")[0]).toEqual({ cmd: "provider.save", id: "file", fields: { project: "p1" } });
    expect(link.commands("provider.use")).toEqual([{ cmd: "provider.use", id: "file", model: "the-model" }]);
  });
  test("what was said of the save is on the list of models, not used up by the screen that waited for them", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "plain", key: true }]) : c.cmd === "provider.models" ? models("plain", ["x"]) : undefined);
    const t = scripted(["Plain Service", "Plain Service key", "Save", "x"], ["sk-ok"]);
    await keysScreen(t.kit(link), ENTRIES);
    expect(t.shown.find((s) => s.title.startsWith("Asking"))!.frame.notice).toBeUndefined();
    expect(t.shown.find((s) => s.title === "Which model?")!.frame.notice).toEqual(["Plain Service key saved."]);
  });
  test("a service that cannot be reached after saving says so on its page, with the key kept", async () => {
    const link = new FakeLink((c) => c.cmd === "providers" ? providers([]) : c.cmd === "provider.save" ? providers([{ id: "plain", key: true }]) : c.cmd === "provider.models" ? "Plain Service could not be reached." : undefined);
    const t = scripted(["Plain Service", "Plain Service key", "Save", undefined, undefined], ["sk-ok"]);
    await keysScreen(t.kit(link), ENTRIES);
    const page = t.shown.filter((s) => s.title === "Plain Service").at(-1)!;
    expect(page.frame.notice).toEqual(["Plain Service could not be reached."]);
    expect(page.items.map((i) => i.label)).toContain("Remove");
  });
});

describe("a service with a key saved", () => {
  const saved = (): FakeLink => new FakeLink((c) => c.cmd === "providers" ? providers([{ id: "plain", key: true }]) : c.cmd === "provider.remove" ? providers([]) : undefined);
  test("Remove takes it away at once, and says so on the list", async () => {
    const link = saved();
    const t = scripted(["Plain Service", "Remove", undefined]);
    await keysScreen(t.kit(link), ENTRIES);
    expect(link.commands("provider.remove")).toEqual([{ cmd: "provider.remove", id: "plain" }]);
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Plain Service key removed."]);
  });
  test("a hub that refuses the list is said as it is, and the screen ends", async () => {
    const link = new FakeLink(() => "A key is kept only on a computer, never in Navvied Cloud.");
    const t = scripted([]);
    const kit = t.kit(link);
    expect(await keysScreen(kit, ENTRIES)).toBe("back");
    expect(kit.note).toEqual(["A key is kept only on a computer, never in Navvied Cloud."]);
  });
});
