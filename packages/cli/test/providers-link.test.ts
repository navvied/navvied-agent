import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import { HubLink } from "../src/providers/link.ts";

const setup = () => { const sent: object[] = []; return { link: new HubLink((c) => sent.push(c)), sent }; };

describe("the link between a screen and the hub", () => {
  test("a command is answered by the next event of its name", async () => {
    const { link, sent } = setup();
    const answer = link.call("providers", { cmd: "providers" });
    expect(sent).toEqual([{ cmd: "providers" }]);
    expect(link.onEvent({ ev: "providers", items: [] })).toBe(true);
    expect(await answer).toEqual({ ev: "providers", items: [] });
  });
  test("an error answers the oldest command that waits, as a sentence, and the conversation does not repeat it", async () => {
    const { link } = setup();
    const first = link.call("providers", { cmd: "provider.save" });
    const second = link.call("endpoints", { cmd: "endpoints" });
    expect(link.onEvent({ ev: "error", msg: "No." })).toBe(true);
    expect(await first).toBe("No.");
    link.onEvent({ ev: "endpoints", items: [] });
    expect(await second).toEqual({ ev: "endpoints", items: [] });
  });
  test("an error with no command waiting is the conversation's", () => {
    expect(setup().link.onEvent({ ev: "error", msg: "Boom." })).toBe(false);
  });
  test("events that belong to the screens are not shown in the conversation; the others are", () => {
    const { link } = setup();
    for (const e of [{ ev: "local.file", repo: "r", file: "f", state: "idle" }, { ev: "machine", os: "linux", arch: "x64", gpus: [], ramMb: 1 }, { ev: "endpoint.models", api: "chat", items: [] }, { ev: "provider.models", id: "x", models: [] }] as EngineEvent[]) expect(link.onEvent(e), e.ev).toBe(true);
    expect(link.onEvent({ ev: "done" } as EngineEvent)).toBe(false);
  });
  test("a watcher sees every event until it stops", () => {
    const { link } = setup();
    const seen: string[] = [];
    const off = link.watch((e) => seen.push(e.ev));
    link.onEvent({ ev: "local.file", repo: "r", file: "f", state: "done" });
    off();
    link.onEvent({ ev: "local.file", repo: "r", file: "f", state: "idle" });
    expect(seen).toEqual(["local.file"]);
  });
  test("ask does not take an error: a failure of that command is left to the conversation", () => {
    const { link } = setup();
    link.ask("artifact", { cmd: "artifact.read" }, () => undefined);
    expect(link.onEvent({ ev: "error", msg: "No file." })).toBe(false);
  });
});
