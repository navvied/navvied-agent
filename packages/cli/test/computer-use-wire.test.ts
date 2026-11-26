import { afterAll, describe, expect, test } from "bun:test";
import { computerWire } from "../src/computer-use/wire.ts";
import type { Grants } from "../src/computer-use/grants.ts";
import { fakeIO, remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => { dirs.forEach(remove); });

const GRANTED: Grants = { state: () => "granted", ask: () => undefined, settings: () => undefined };

function wired(load: () => Promise<Grants>) {
  const home = tempDir();
  dirs.push(home);
  let changes = 0;
  const wire = computerWire({ io: fakeIO({ env: { HOME: home } }).io, changed: () => { changes++; }, unavailable: () => undefined, open: () => undefined, platform: "darwin", grants: load });
  return { port: wire.port, changes: () => changes };
}

describe("a computer whose grants are read after the program has started", () => {
  test("announces nothing by itself: no window is told about the screen before it asks", async () => {
    let finish: (g: Grants) => void = () => undefined;
    const w = wired(() => new Promise<Grants>((r) => { finish = r; }));
    finish(GRANTED);
    await w.port.state();
    expect(w.changes()).toBe(0);
  });

  test("a question asked before they are read waits for them and answers with them, never with a guess", async () => {
    let finish: (g: Grants) => void = () => undefined;
    const w = wired(() => new Promise<Grants>((r) => { finish = r; }));
    const asked = w.port.state();
    finish(GRANTED);
    expect((await asked).permissions.map((p) => p.state)).toEqual(["granted", "granted"]);
  });

  test("when they cannot be read, every grant reads as missing", async () => {
    const w = wired(() => Promise.reject(new Error("no library")));
    expect((await w.port.state()).permissions.map((p) => p.state)).toEqual(["missing", "missing"]);
    expect(w.changes()).toBe(0);
  });

  test("the step for the tools row is known without anyone asking", async () => {
    const w = wired(() => Promise.resolve(GRANTED));
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(w.port.step).toBe("install");
  });
});
