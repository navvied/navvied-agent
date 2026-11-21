import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach(remove));
const AGENT = join(import.meta.dir, "../../stream-engine/test/fake-agent.ts");

async function capsOf(entry: object) {
  const state = tempDir();
  dirs.push(state);
  const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0" };
  mkdirSync(dirname(configPath(env)), { recursive: true });
  writeFileSync(configPath(env), JSON.stringify({ default: "helper", models: { helper: entry } }));
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: state } as never, fakeIO({ env }).io, { watch: false, import: false });
  const got: { ev: string; models?: { id: string; name: string; current?: boolean }[] }[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  await until(() => got.some((e) => e.ev === "caps"));
  await hub.stop();
  return got.find((e) => e.ev === "caps")!;
}

describe("a program the person signed in to still has a model every window is told about", () => {
  test("a plain entry (no list of models) announces exactly one current model: its own id and name", async () => {
    expect((await capsOf({ command: "bun", args: [AGENT], window: 50000 })).models).toEqual([{ id: "helper", name: "helper", current: true }]);
    expect((await capsOf({ command: "bun", args: [AGENT], window: 50000, display: { name: "The helper program" } })).models).toEqual([{ id: "helper", name: "The helper program", current: true }]);
  });
});
