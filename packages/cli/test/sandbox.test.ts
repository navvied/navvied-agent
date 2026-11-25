import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "@navvied/protocol";
import { loadConfig } from "../src/config.ts";
import { SandboxState, sandboxInfo, sandboxSetting } from "../src/sandbox.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-sandbox-cli-"));
afterAll(hook("sandbox settings remove what they made", async () => { await removeTree(dir); }), HOOK_MS);
const write = (name: string, body: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(body)); return p; };

describe("the sandbox setting", () => {
  test("it is on with the network on until something says otherwise; the configuration then the person's choice decide", () => {
    const state = new SandboxState(join(dir, "none.json"));
    expect(sandboxSetting(state, undefined)).toEqual({ on: true, network: true });
    expect(sandboxSetting(state, "off")).toEqual({ on: false, network: true });
    expect(sandboxSetting(state, { network: false })).toEqual({ on: true, network: false });
    const chosen = new SandboxState(join(dir, "chosen.json"));
    chosen.set({ on: true });
    expect(sandboxSetting(chosen, "off")).toEqual({ on: true, network: true });
    chosen.set({ network: false });
    expect(sandboxSetting(chosen, "off")).toEqual({ on: true, network: false });
    if (process.platform !== "win32") expect(statSync(join(dir, "chosen.json")).mode & 0o077).toBe(0);
  });

  test("the configuration key is read, and a wrong one is refused with the file's name", () => {
    for (const v of ["on", "off", { network: false }, {}]) { const r = loadConfig(write("ok.json", { models: {}, sandbox: v }), {}); expect(r.ok && r.value?.sandbox).toEqual(v as never); }
    const bad = loadConfig(write("bad.json", { models: {}, sandbox: { network: "no" } }), {});
    expect(!bad.ok && bad.error).toContain('"sandbox" must be "on", "off" or { "network": true or false }');
  });

  test("a screen is told what confines commands here, and why not when nothing does", () => {
    const here = sandboxInfo({ on: true, network: false }, "aix");
    expect(here).toEqual({ on: true, network: false, how: "none", why: "this system has no sandbox navvied can use" });
  });

  test("the command is checked: either field, booleans only, at least one", () => {
    expect(parseCommand('{"cmd":"sandbox.use","on":false}')).toEqual({ ok: true, value: { cmd: "sandbox.use", on: false } });
    expect(parseCommand('{"cmd":"sandbox.use","network":false,"on":true}')).toEqual({ ok: true, value: { cmd: "sandbox.use", on: true, network: false } });
    expect(parseCommand('{"cmd":"sandbox.use"}').ok).toBe(false);
    expect(parseCommand('{"cmd":"sandbox.use","on":"yes"}').ok).toBe(false);
  });
});
