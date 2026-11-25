import { findChrome } from "@navvied/engine";
import { afterAll, describe, expect, test } from "bun:test";
import { validateCommand } from "@navvied/protocol";
import { createHub } from "../src/commands/hub.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

describe("the setup of media tools through the hub", () => {
  test("the commands are checked", () => {
    expect(validateCommand({ cmd: "tool.setup", id: "image", mode: "bypass" })).toEqual({ ok: true, value: { cmd: "tool.setup", id: "image", mode: "bypass" } });
    expect(validateCommand({ cmd: "tool.setup", id: "image" })).toEqual({ ok: true, value: { cmd: "tool.setup", id: "image" } });
    expect(validateCommand({ cmd: "tool.setup", id: "image", mode: "wild" }).ok).toBe(false);
    expect(validateCommand({ cmd: "tool.setup.approve", id: "image" }).ok).toBe(true);
    expect(validateCommand({ cmd: "tool.setup.cancel", id: "Image!" }).ok).toBe(false);
  });

  test("every media row has a setup to start, and video generation answers that it is not local", async () => {
    const state = tempDir(), work = tempDir();
    dirs.push(state, work);
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false, import: false });
    const got: { ev: string; [k: string]: unknown }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
    send({ cmd: "tools" });
    await until(() => got.some((e) => e.ev === "tools"));
    const entries = (got.find((e) => e.ev === "tools") as unknown as { entries: { id: string; setup?: true; state: string }[] }).entries;
    for (const id of ["vision", "speech-to-text", "text-to-speech", "image", "video-generation", "video-analysis"]) expect(entries.find((e) => e.id === id), id).toMatchObject({ setup: true, state: "needs-setup" });
    expect(entries.find((e) => e.id === "browser")!.setup).toBe(true);
    send({ cmd: "tool.setup", id: "video-generation" });
    await until(() => got.some((e) => e.ev === "tool.setup"));
    expect(got.find((e) => e.ev === "tool.setup")).toMatchObject({ id: "video-generation", state: "unavailable", error: "Video cannot be made on this computer. It needs a service." });
    send({ cmd: "tool.setup", id: "browser" });
    await until(() => got.some((e) => e.ev === "tool.setup" && e.id === "browser"));
    expect(got.find((e) => e.ev === "tool.setup" && e.id === "browser")).toMatchObject(findChrome({}) ? { state: "done" } : { state: "unavailable", error: "No browser was found on this computer." });
    send({ cmd: "tool.setup.approve", id: "image" });
    send({ cmd: "tool.setup.cancel", id: "image" });
    expect(got.filter((e) => e.ev === "error")).toEqual([]);
    await hub.stop();
  });
});
