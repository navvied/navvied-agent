import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriverHost, driverEnv, missingFrom, type Child, type Spawn } from "../src/computer-use/host.ts";
import { McpClient, NotSent, OutcomeUnknown, type Tool, type Wire } from "../src/computer-use/mcp.ts";
import { PIN } from "../src/computer-use/pin.ts";

/** A stand-in driver: speaks the same line-delimited protocol and records what it was asked. */
function fakeServer(tools: Tool[] = [{ name: "click", inputSchema: { properties: { pid: {}, delivery_mode: {} } } }, { name: "type_text", inputSchema: { properties: { pid: {}, text: {}, delivery_mode: {} } } }], silent = new Set<string>()) {
  const seen: { method: string; params: any }[] = [];
  let lineFn: (l: string) => void = () => {}, closeFn: () => void = () => {};
  const wire: Wire = {
    write(line) {
      const m = JSON.parse(line); seen.push({ method: m.method, params: m.params });
      if (m.id === undefined || silent.has(m.method === "tools/call" ? m.params.name : m.method)) return;
      const result = m.method === "tools/list" ? { tools } : m.method === "tools/call"
        ? { content: [{ type: "text", text: `did ${m.params.name}` }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: { ok: true }, isError: m.params.name === "bad" }
        : {};
      queueMicrotask(() => lineFn(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })));
    },
    onLine: (f) => { lineFn = f; }, onClose: (f) => { closeFn = f; },
  };
  return { wire, seen, close: () => closeFn(), say: (l: string) => lineFn(l) };
}

describe("the tool-protocol client", () => {
  test("opens a session, lists tools and returns text, image and structured data of a call", async () => {
    const s = fakeServer(); const c = new McpClient(s.wire);
    await c.initialize();
    expect((await c.tools()).map((t) => t.name)).toEqual(["click", "type_text"]);
    const r = await c.call("click", { pid: 1 });
    expect(r).toEqual({ isError: false, text: "did click", structured: { ok: true }, image: { mime: "image/png", data: "AAAA" } });
    expect(s.seen.map((m) => m.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect((await c.call("bad", {})).isError).toBe(true);
  });
  test("a call that gets no answer is an unknown outcome, never a plain failure the caller may repeat", async () => {
    const s = fakeServer(undefined, new Set(["click"])); const c = new McpClient(s.wire);
    await expect(c.call("click", {}, 20)).rejects.toBeInstanceOf(OutcomeUnknown);
  });
  test("a driver that stops while a call is waiting is an unknown outcome; afterwards nothing is sent", async () => {
    const s = fakeServer(undefined, new Set(["click"])); const c = new McpClient(s.wire);
    const p = c.call("click", {}); s.close();
    await expect(p).rejects.toBeInstanceOf(OutcomeUnknown);
    const before = s.seen.length;
    await expect(c.call("click", {})).rejects.toBeInstanceOf(NotSent);
    expect(s.seen.length).toBe(before);
  });
  test("lines that are not answers are ignored", async () => {
    const s = fakeServer(); const c = new McpClient(s.wire);
    s.say("garbage"); s.say(JSON.stringify({ id: 99, result: {} })); s.say(JSON.stringify({ method: "notifications/x" }));
    await c.initialize();
  });
});

describe("what the driver is given", () => {
  test("only the environment it needs: no keys, no tokens; embedded, standard, never unrestricted", () => {
    const env = driverEnv({ PATH: "/bin", HOME: "/h", PROVIDER_API_KEY: "k", NAVVIED_TOKEN: "t", DISPLAY: ":0" }, PIN);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", DISPLAY: ":0", CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_PERMISSION_MODE: "standard", CUA_DRIVER_HOST_BUNDLE_ID: PIN.bundleId });
    expect(JSON.stringify(env)).not.toMatch(/unrestricted/i);
  });
  test("a driver missing a needed tool or property is not the pinned one", () => {
    expect(missingFrom(PIN, [])).toEqual(["click", "type_text"]);
    expect(missingFrom(PIN, [{ name: "click", inputSchema: { properties: { pid: {} } } }, { name: "type_text", inputSchema: { properties: { pid: {}, text: {}, delivery_mode: {} } } }])).toEqual(["click.delivery_mode"]);
  });
});

/** A fake machine: the daemon and the proxy are children; the proxy's end of the wire is a fake server. */
function machine(opts: { answersStatus?: boolean; tools?: Parameters<typeof fakeServer>[0] } = {}) {
  const started: { cmd: string; args: string[]; env: Record<string, string>; child: Child & { exit: (c: number | null) => void; killed: number; inputClosed: boolean } }[] = [];
  const server = fakeServer(opts.tools);
  const spawn: Spawn = (cmd, args, env) => {
    let exitFn: (c: number | null) => void = () => {}, lineFn: (l: string) => void = () => {};
    const isProxy = args[0] === "mcp";
    if (isProxy) server.wire.onLine((l) => lineFn(l));
    const child = {
      killed: 0, inputClosed: false,
      write: (d: string) => { if (isProxy) for (const l of d.split("\n").filter(Boolean)) server.wire.write(l); },
      onLine: (f: (l: string) => void) => { lineFn = f; }, onExit: (f: (c: number | null) => void) => { exitFn = f; },
      closeInput() { child.inputClosed = true; }, kill() { child.killed++; }, exit: (c: number | null) => exitFn(c),
    };
    started.push({ cmd, args, env, child });
    return child;
  };
  const probes: string[][] = [];
  const probe = async (_c: string, a: string[]) => { probes.push(a); return opts.answersStatus !== false && started.length > 0; };
  const stopped: boolean[] = [];
  const host = new DriverHost({ entry: "/driver", pin: PIN, platform: "linux", env: { PATH: "/bin", SECRET_KEY: "x" }, stateDir: join(mkdtempSync(join(tmpdir(), "cu-")), "s"), pid: 1, spawn, probe, readyMs: 200, stepMs: 5, onStopped: (u) => stopped.push(u) });
  return { host, started, probes, stopped, server };
}

describe("the driver as two children of this program", () => {
  test("starts the daemon embedded with a private socket, waits for it, then the proxy on the same socket; the environment holds no secret", async () => {
    const m = machine();
    const r = await m.host.start();
    expect(r.ok).toBe(true);
    const [daemon, proxy] = m.started;
    expect(daemon!.args.slice(0, 2)).toEqual(["serve", "--embedded"]);
    expect(daemon!.args).toContain("--parent-liveness-stdio");
    const sock = daemon!.args[daemon!.args.indexOf("--socket") + 1]!;
    expect(proxy!.args).toEqual(["mcp", "--embedded", "--socket", sock]);
    expect(m.probes[0]).toEqual(["status", "--socket", sock]);
    for (const c of m.started) { expect(c.env.SECRET_KEY).toBeUndefined(); expect(c.env.CUA_DRIVER_EMBEDDED).toBe("1"); }
  });
  test("starts that overlap are one start", async () => {
    const m = machine();
    const [a, b] = await Promise.all([m.host.start(), m.host.start()]);
    expect(a).toBe(b);
    expect(m.started.length).toBe(2);
  });
  test("a daemon that never answers ends the start and is closed down", async () => {
    const m = machine({ answersStatus: false });
    expect(await m.host.start()).toMatchObject({ ok: false, why: "not-ready" });
    expect(m.started.length).toBe(1);
    expect(m.started[0]!.child.inputClosed).toBe(true);
  });
  test("a driver of another build is refused and closed down, naming what is missing", async () => {
    const m = machine({ tools: [{ name: "click", inputSchema: { properties: { pid: {} } } }] });
    const r = await m.host.start();
    expect(r).toMatchObject({ ok: false, why: "mismatch" });
    expect((r as { message: string }).message).toContain("click.delivery_mode");
    expect(m.started.every((c) => c.child.inputClosed || c.child.killed > 0)).toBe(true);
  });
  test("stop closes the daemon's input (its signal to end) and kills the proxy; stopping twice does it once", async () => {
    const m = machine(); await m.host.start();
    m.host.stop(); m.host.stop();
    expect(m.started[0]!.child.inputClosed).toBe(true);
    expect(m.started[1]!.child.killed).toBe(1);
    expect(m.stopped).toEqual([false]);
    await expect(m.host.call("click", {})).rejects.toBeInstanceOf(NotSent);
  });
  test("close waits for the daemon to be gone and kills one that stays", async () => {
    const m = machine(); await m.host.start();
    const d = m.started[0]!.child;
    const closing = m.host.close(30);
    await new Promise((r) => setTimeout(r, 60));
    await closing;
    expect(d.inputClosed).toBe(true);
    expect(d.killed).toBeGreaterThan(0);
    const m2 = machine(); await m2.host.start();
    const c2 = m2.host.close(500);
    m2.started[0]!.child.exit(0);
    await c2;
    expect(m2.started[0]!.child.killed).toBe(0);
  });
  test("a daemon that dies by itself is reported once as unexpected and the driver is not started again", async () => {
    const m = machine(); await m.host.start();
    m.started[0]!.child.exit(1);
    expect(m.stopped).toEqual([true]);
    expect(m.host.running).toBeUndefined();
    expect(m.started.length).toBe(2);
    await expect(m.host.call("click", {})).rejects.toBeInstanceOf(NotSent);
  });
  test("calls reach the driver through the running client", async () => {
    const m = machine(); await m.host.start();
    expect((await m.host.call("click", { pid: 7 })).text).toBe("did click");
  });
});

describe("with real child programs", () => {
  const fixture = join(import.meta.dir, "fixtures", "fake-driver.ts");
  test.skipIf(process.platform === "win32")("the same host starts, talks to and stops a real process pair; closing the daemon's input is what ends it", async () => {
    const { spawnChild, probeStatus } = await import("../src/computer-use/system.ts");
    const { existsSync, readFileSync } = await import("node:fs");
    const stateDir = join(mkdtempSync(join(tmpdir(), "cu-")), "s");
    const host = new DriverHost({ entry: fixture, pin: PIN, platform: process.platform, env: { ...process.env, SECRET_KEY: "x" }, stateDir, pid: process.pid, spawn: spawnChild, probe: probeStatus, readyMs: 5000, stepMs: 20 });
    const r = await host.start();
    expect(r.ok).toBe(true);
    expect((await host.call("click", { pid: 1 })).text).toBe("ok");
    const sockDir = (await import("node:fs")).readdirSync(stateDir).find((n) => n.startsWith("sock-"))!;
    const marker = join(stateDir, sockDir, "driver.sock");
    expect(JSON.parse(readFileSync(marker + ".env", "utf8"))).not.toContain("SECRET_KEY");
    host.stop();
    for (let i = 0; i < 100 && !existsSync(marker + ".ended"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(marker + ".ended")).toBe(true);
  });
});
