import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseCommand, type ComputerState } from "@navvied/protocol";
import { createHub, type ComputerPort } from "../src/commands/hub.ts";
import { fakeIO, remove, startMockModel, tempDir, until } from "./helpers.ts";

let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

type Ev = { ev: string; [k: string]: unknown };

function open(computer?: (changed: () => void) => ComputerPort) {
  const state = tempDir(), work = tempDir();
  dirs.push(state, work);
  const env = { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
  const hub = createHub({ json: false, yes: false, thinking: false, cwd: work } as never, fakeIO({ env }).io, { watch: false, ...(computer ? { computer } : {}) });
  const got: Ev[] = [];
  hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
  const send = (cmd: object): void => hub.command(JSON.stringify(cmd), () => undefined);
  const states = (): ComputerState[] => got.filter((e) => e.ev === "computer.state") as unknown as ComputerState[];
  return { hub, got, send, states };
}

test("the commands are checked: a grant is one of two, the switch is a boolean", () => {
  expect(parseCommand('{"cmd":"computer.state"}').ok).toBe(true);
  expect(parseCommand('{"cmd":"computer.permission","id":"screen-recording"}')).toEqual({ ok: true, value: { cmd: "computer.permission", id: "screen-recording" } });
  expect(parseCommand('{"cmd":"computer.permission","id":"camera"}').ok).toBe(false);
  expect(parseCommand('{"cmd":"computer.on","on":true}')).toEqual({ ok: true, value: { cmd: "computer.on", on: true } });
  expect(parseCommand('{"cmd":"computer.on","on":"yes"}').ok).toBe(false);
});

test("without the desktop app the state is unavailable, with a reason and no grants", async () => {
  const { hub, send, states } = open();
  send({ cmd: "computer.state" });
  await until(() => states().length > 0);
  expect(states()[0]).toMatchObject({ on: false, step: "unavailable", permissions: [] });
  expect(typeof states()[0]!.reason).toBe("string");
  await hub.stop();
});

test("the native side's state is told on ask, after a grant is requested, after the switch, and when it says it changed by itself", async () => {
  let granted = false, on = false, poke = (): void => undefined;
  const asked: string[] = [];
  const port: ComputerPort = {
    state: async () => ({ on, step: granted ? "ready" : "permissions", permissions: [{ id: "accessibility", state: "granted" }, { id: "screen-recording", state: granted ? "granted" : "missing" }] }),
    request: async (id) => { asked.push(id); },
    turn: async (v) => { on = v; },
  };
  const { hub, send, states } = open((changed) => { poke = changed; return port; });
  send({ cmd: "computer.state" });
  await until(() => states().length === 1);
  expect(states()[0]).toMatchObject({ ev: "computer.state", on: false, step: "permissions", permissions: [{ id: "accessibility", state: "granted" }, { id: "screen-recording", state: "missing" }] } as never);
  send({ cmd: "computer.permission", id: "screen-recording" });
  await until(() => states().length === 2);
  expect(asked).toEqual(["screen-recording"]);
  granted = true;
  poke();
  await until(() => states().length === 3);
  expect(states()[2]!.step).toBe("ready");
  send({ cmd: "computer.on", on: true });
  await until(() => states().length === 4);
  expect(states()[3]!.on).toBe(true);
  await hub.stop();
});
