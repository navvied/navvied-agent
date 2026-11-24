import { describe, expect, test } from "bun:test";
import type { EndpointSaved, EngineEvent } from "@navvied/protocol";
import { draftOf, endpointRows, endpointsScreen, formRows } from "../src/providers/endpoints.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

const mine: EndpointSaved = { id: "my-server", name: "my-server", baseUrl: "http://localhost:8080/v1", api: "chat", key: true, models: [{ id: "my-model", window: 32768, vision: true }] };
const endpoints = (items: EndpointSaved[]): EngineEvent => ({ ev: "endpoints", items });

describe("the list and the form", () => {
  test("each endpoint shows its address; adding one is the last row", () => {
    expect(endpointRows([mine]).map((r) => [r.label, r.hint])).toEqual([["my-server", "http://localhost:8080/v1"], ["Add endpoint", undefined]]);
    expect(endpointRows([]).map((r) => r.label)).toEqual(["Add endpoint"]);
  });
  test("a saved endpoint shows what it has, in the order of the page: settings, models, then what can be done", () => {
    expect(formRows(draftOf(mine)).map((r) => [r.label, r.hint])).toEqual([
      ["Name", "my-server"], ["Endpoint URL", "http://localhost:8080/v1"], ["API style", "Chat completions"], ["API key", "Saved"],
      ["my-model", "Context window 32768. Sees images"], ["Find models", undefined], ["Add model", undefined], ["Remove endpoint", undefined], ["Save", undefined],
    ]);
  });
  test("a new endpoint has no Remove, and shows an example where nothing is set yet", () => {
    expect(formRows(draftOf()).map((r) => [r.label, r.hint])).toEqual([["Name", "my-server"], ["Endpoint URL", "http://localhost:8080/v1"], ["API style", "Chat completions"], ["API key", "Optional"], ["Find models", undefined], ["Add model", undefined], ["Save", undefined]]);
  });
});

describe("adding an endpoint", () => {
  test("name, address, style and a hidden key, then the models its server lists; saved with the style it answered in", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([]) : c.cmd === "endpoint.models" ? { ev: "endpoint.models", api: "messages", items: [{ id: "m1", window: 8192 }, { id: "m2" }] } : c.cmd === "endpoint.save" ? endpoints([mine]) : undefined);
    const t = scripted(["Add endpoint", "Name", "Endpoint URL", "API style", "Messages", "API key", "Find models", "m1", "Save", undefined], ["box", "http://box:1/v1", "sk-box"]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.models")).toEqual([{ cmd: "endpoint.models", baseUrl: "http://box:1/v1", api: "messages", key: "sk-box" }]);
    expect(link.commands("endpoint.save")).toEqual([{ cmd: "endpoint.save", name: "box", baseUrl: "http://box:1/v1", api: "messages", key: "sk-box", models: [{ id: "m1", window: 8192 }] }]);
    expect(t.shown.map((s) => s.frame).flatMap((f) => f.notice ?? [])).toContain("The endpoint answered. 2 models found.");
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Saved."]);
    expect(JSON.stringify(t.shown)).not.toContain("sk-box");
  });
  test("a save the hub refuses says why, on the form, and the form stays as it was", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([]) : c.cmd === "endpoint.save" ? "The endpoint needs a name." : undefined);
    const t = scripted(["Add endpoint", "Save", undefined, undefined]);
    await endpointsScreen(t.kit(link));
    expect(t.shown[2]!.title).toBe("New endpoint");
    expect(t.shown[2]!.frame.notice).toEqual(["The endpoint needs a name."]);
  });
  test("a server that does not answer says why, and nothing is added", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([]) : c.cmd === "endpoint.models" ? "The server could not be reached." : undefined);
    const t = scripted(["Add endpoint", "Endpoint URL", "Find models", undefined, undefined], ["http://box:1/v1"]);
    await endpointsScreen(t.kit(link));
    expect(t.shown[4]!.frame.notice).toEqual(["The server could not be reached."]);
  });
  test("a model typed by hand takes a name and a context window (a whole number, or none), and can see images and read PDF files", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([]) : c.cmd === "endpoint.save" ? endpoints([]) : undefined);
    const t = scripted(["Add endpoint", "Name", "Endpoint URL", "Add model", "Model", "Context window", "Context window", "Sees images", "Reads PDF files", undefined, "Save", undefined], ["box", "http://box:1/v1", "my-model", "lots", "16000"]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.save")[0]!.models).toEqual([{ id: "my-model", window: 16000, vision: true, pdf: true }]);
  });
  test("a model left without a name is not kept", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([]) : undefined);
    const t = scripted(["Add endpoint", "Add model", undefined, undefined, undefined]);
    await endpointsScreen(t.kit(link));
    expect(t.shown.at(-1)!.items.map((i) => i.label)).not.toContain("New model");
  });
});

describe("an endpoint that is saved", () => {
  test("its models are asked by its id while the address and style are as they were, so its saved key is used", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([mine]) : c.cmd === "endpoint.models" ? { ev: "endpoint.models", api: "chat", items: [{ id: "my-model" }] } : undefined);
    const t = scripted(["my-server", "Find models", undefined, undefined, undefined]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.models")).toEqual([{ cmd: "endpoint.models", id: "my-server" }]);
    expect(t.shown.flatMap((s) => s.frame.notice ?? [])).toContain("Every model it has is already added.");
  });
  test("after the address changes they are asked by the form's own address, and a key of the person's is not asked for again", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([mine]) : c.cmd === "endpoint.models" ? { ev: "endpoint.models", api: "chat", items: [] } : undefined);
    const t = scripted(["my-server", "Endpoint URL", "Find models", undefined, undefined, undefined], ["http://other:2/v1"]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.models")).toEqual([{ cmd: "endpoint.models", baseUrl: "http://other:2/v1", api: "chat" }]);
  });
  test("saving keeps the key it has unless a new one was pasted", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" || c.cmd === "endpoint.save" ? endpoints([mine]) : undefined);
    const t = scripted(["my-server", "Save", "my-server", "API key", "Save", undefined], ["sk-new"]);
    await endpointsScreen(t.kit(link));
    const [first, second] = link.commands("endpoint.save");
    expect(first).toEqual({ cmd: "endpoint.save", id: "my-server", name: "my-server", baseUrl: "http://localhost:8080/v1", api: "chat", models: mine.models });
    expect(second!.key).toBe("sk-new");
  });
  test("Remove endpoint takes it away at once and says Removed.", async () => {
    let items = [mine];
    const link = new FakeLink((c) => { if (c.cmd === "endpoint.remove") items = []; return c.cmd === "endpoints" || c.cmd === "endpoint.remove" ? endpoints(items) : undefined; });
    const t = scripted(["my-server", "Remove endpoint", undefined]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.remove")).toEqual([{ cmd: "endpoint.remove", id: "my-server" }]);
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Removed."]);
  });
  test("a model can be removed from the list before saving", async () => {
    const link = new FakeLink((c) => c.cmd === "endpoints" ? endpoints([mine]) : c.cmd === "endpoint.save" ? "The endpoint needs a model." : undefined);
    const t = scripted(["my-server", "my-model", "Remove model", "Save", undefined, undefined]);
    await endpointsScreen(t.kit(link));
    expect(link.commands("endpoint.save")[0]!.models).toEqual([]);
  });
  test("the hub's refusal (a cloud session) is said and the screen ends", async () => {
    const link = new FakeLink(() => "Endpoints are only on a computer.");
    const t = scripted([]);
    const kit = t.kit(link);
    expect(await endpointsScreen(kit)).toBe("back");
    expect(kit.note).toEqual(["Endpoints are only on a computer."]);
  });
});
