import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import type { GrantId, GrantState, Grants } from "../src/computer-use/grants.ts";
import { entryOf } from "../src/computer-use/install.ts";
import { ComputerHere } from "../src/computer-use/port.ts";
import { PIN } from "../src/computer-use/pin.ts";
import { ComputerUse, type ServiceInput } from "../src/computer-use/service.ts";
import { probeStatus, spawnChild } from "../src/computer-use/system.ts";

function grants(initial: Record<GrantId, GrantState> = { accessibility: "missing", "screen-recording": "missing" }) {
  const state = { ...initial }, log: string[] = [];
  const g: Grants = { state: (id) => state[id], ask: (id) => { log.push(`ask ${id}`); }, settings: (id) => { log.push(`settings ${id}`); } };
  return { g, state, log };
}
const input = (over: Partial<ServiceInput> = {}): ServiceInput => ({
  platform: "darwin", arch: "arm64", env: {}, dir: mkdtempSync(join(tmpdir(), "cu-")), fetchFn: fetch, run: async () => ({ code: 0, out: "", err: "" }), spawn: spawnChild, probe: probeStatus, pid: 1, ownApps: [], ...over,
});
const here = (use: ComputerUse, g: Grants, on = { v: false }, extra: { unavailable?: string } = {}) => {
  const changed: number[] = [];
  const port = new ComputerHere({ use, grants: g, isOn: () => on.v, setOn: (v) => { on.v = v; }, changed: () => { changed.push(1); }, ...extra });
  return { port, changed, on };
};
const installIt = (i: ServiceInput) => { const e = entryOf(i.dir, PIN, "darwin"); mkdirSync(dirname(e), { recursive: true }); writeFileSync(e, "x"); };

describe("where turning on computer use stands", () => {
  test("a system that cannot be driven says why, whatever else is true", async () => {
    const { port } = here(new ComputerUse(input({ platform: "linux", arch: "x64", env: { XDG_SESSION_TYPE: "wayland" } })), grants().g);
    expect(await port.state()).toMatchObject({ on: false, step: "unavailable", reason: expect.stringContaining("Wayland") });
    const cloud = here(new ComputerUse(input()), grants().g, undefined, { unavailable: "Computer use needs the desktop app." });
    expect(await cloud.port.state()).toMatchObject({ step: "unavailable", reason: "Computer use needs the desktop app." });
  });
  test("install, then permissions, then ready, in that order", async () => {
    const i = input(); const gr = grants();
    const { port } = here(new ComputerUse(i), gr.g);
    expect(await port.state()).toMatchObject({ step: "install", permissions: [{ id: "accessibility", state: "missing" }, { id: "screen-recording", state: "missing" }] });
    installIt(i);
    expect((await port.state()).step).toBe("permissions");
    gr.state.accessibility = "granted"; gr.state["screen-recording"] = "granted";
    expect(await port.state()).toMatchObject({ step: "ready", on: false });
  });
  test("a system with no grants goes from the driver straight to ready", async () => {
    const i = input({ platform: "linux", arch: "x64", env: { DISPLAY: ":0" } });
    const e = entryOf(i.dir, PIN, "linux-x86_64"); mkdirSync(dirname(e), { recursive: true }); writeFileSync(e, "x");
    const { port } = here(new ComputerUse(i), grants({ accessibility: "not-needed", "screen-recording": "not-needed" }).g);
    expect(await port.state()).toMatchObject({ step: "ready", permissions: [{ state: "not-needed" }, { state: "not-needed" }] });
  });
});

describe("a grant and the switch", () => {
  test("the system asks the first time; afterwards, and when it was refused, System Settings opens; a grant already given is left alone", async () => {
    const gr = grants(); const { port, changed } = here(new ComputerUse(input()), gr.g);
    await port.request("accessibility"); await port.request("accessibility"); await port.request("screen-recording");
    gr.state["screen-recording"] = "granted"; await port.request("screen-recording");
    expect(gr.log).toEqual(["ask accessibility", "settings accessibility", "ask screen-recording"]);
    expect(changed.length).toBe(3);
  });
  test("it cannot be switched on before it is ready; switched off it stops the driver and forgets", async () => {
    const i = input(); const gr = grants({ accessibility: "granted", "screen-recording": "granted" });
    const use = new ComputerUse(i); const on = { v: false };
    const { port } = here(use, gr.g, on);
    await port.turn(true);
    expect(on.v).toBe(false);
    installIt(i);
    await port.turn(true);
    expect(on.v).toBe(true);
    expect((await port.state()).on).toBe(true);
    await port.turn(false);
    expect(on.v).toBe(false);
  });
});

describe("fetching the driver", () => {
  test("progress is told as it comes, then done; a failure is told in plain words and nothing of the cause", async () => {
    const events: EngineEvent[] = [];
    const ok = input({ platform: "darwin" });
    const use = new ComputerUse({ ...ok, install: async (x) => { x.onProgress?.(50, 200); x.onProgress?.(200, 200); return { ok: true, entry: "/x" }; } });
    const { port } = here(use, grants().g);
    await port.setup((e) => events.push(e));
    expect(events.map((e) => (e as { state: string }).state)).toEqual(["downloading", "downloading", "downloading", "done"]);
    expect(events[1]).toMatchObject({ ev: "tool.setup", id: "computer", bytes: 50, total: 200, percent: 25 });
    const bad: EngineEvent[] = [];
    const use2 = new ComputerUse({ ...ok, install: async () => ({ ok: false, why: "signature", message: "/secret/x" }) });
    await here(use2, grants().g).port.setup((e) => bad.push(e));
    expect(bad.at(-1)).toMatchObject({ state: "failed", error: "It could not be checked, so it was not kept." });
    expect(JSON.stringify(bad)).not.toContain("secret");
    const disk: EngineEvent[] = [];
    await here(new ComputerUse({ ...ok, install: async () => ({ ok: false, why: "download", result: { ok: false, why: "nodisk", needBytes: 1, freeBytes: 0 } }) }), grants().g).port.setup((e) => disk.push(e));
    expect(disk.at(-1)).toMatchObject({ state: "failed", error: "There is not enough free space for it." });
  });
  test("a system that cannot be driven says so instead of fetching", async () => {
    const events: EngineEvent[] = [];
    const use = new ComputerUse(input({ platform: "freebsd" }));
    await here(use, grants().g).port.setup((e) => events.push(e));
    expect(events).toEqual([expect.objectContaining({ state: "unavailable" })]);
  });
});

describe("the helper of a conversation and the person's Stop", () => {
  test("there is a helper only while it is on; one conversation keeps its own, another has another", async () => {
    const i = input({ platform: "linux", arch: "x64", env: { DISPLAY: ":0" } });
    const on = { v: false };
    const { port } = here(new ComputerUse(i), grants({ accessibility: "not-needed", "screen-recording": "not-needed" }).g, on);
    const a = {}, b = {};
    expect(port.helper(a)).toBeUndefined();
    on.v = true;
    const ha = port.helper(a);
    expect(ha).toBeDefined();
    expect(port.helper(a)).toBe(ha);
    expect(port.helper(b)).not.toBe(ha);
    on.v = false;
    expect(port.helper(a)).toBeUndefined();
  });
  test("a system that cannot be driven has no helper even when it was switched on", () => {
    const { port } = here(new ComputerUse(input({ platform: "freebsd" })), grants().g, { v: true });
    expect(port.helper({})).toBeUndefined();
  });
  test("when the person takes the screen, steps are refused with human_has_control until it is given back, and state says who has it", async () => {
    const i = input({ platform: "linux", arch: "x64", env: { DISPLAY: ":0" } });
    const e = entryOf(i.dir, PIN, "linux-x86_64"); mkdirSync(dirname(e), { recursive: true }); writeFileSync(e, "x");
    const { port, changed } = here(new ComputerUse(i), grants({ accessibility: "not-needed", "screen-recording": "not-needed" }).g, { v: true });
    const h = port.helper({})!;
    expect((await port.state()).control).toBe("agent");
    await port.control("person");
    expect((await port.state()).control).toBe("person");
    expect(await h.call({ action: "list" })).toMatchObject({ verdict: "refused", code: "human_has_control" });
    await port.control("agent");
    expect((await port.state()).control).toBe("agent");
    expect(changed.length).toBe(2);
  });
});
