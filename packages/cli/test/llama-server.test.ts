import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argsOf, freePort, readNote, reapOrphan, startServer } from "../src/llama-server.ts";
import { remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
const killers: (() => void)[] = [];
afterAll(() => { killers.forEach((k) => k()); dirs.forEach(remove); });
const dir = (): string => { const d = tempDir(); dirs.push(d); return d; };

const win = process.platform === "win32";
/** A program that is the stand-in: a script that starts it with the arguments it was given. */
function fakeBinary(d: string): string {
  const file = join(d, "llama-server");
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-llama.ts")}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the arguments", () => {
  test("the model, the context, the layers on the card, this computer only, a port asked of the system, the template engine, a name, one slot", () => {
    expect(argsOf({ model: "/m/x.gguf", window: 16384, layers: 0, alias: "x" }, 4242)).toEqual(["-m", "/m/x.gguf", "-c", "16384", "-ngl", "0", "--host", "127.0.0.1", "--port", "4242", "--jinja", "-a", "x", "-np", "1"]);
  });

  test("a port is one that nothing listens on", async () => {
    const a = await freePort();
    expect(a).toBeGreaterThan(1023);
    const s = Bun.serve({ port: a, hostname: "127.0.0.1", fetch: () => new Response("") });
    expect(await freePort()).not.toBe(a);
    s.stop(true);
  });
});

describe.skipIf(win)("a server that is started", () => {
  test("is ready when its line says it listens, answers on that port, is a child of this program, and leaves a note of its process", async () => {
    const d = dir(), argsFile = join(d, "args.json");
    const s = await startServer({ binary: fakeBinary(d), model: join(d, "m.gguf"), window: 4096, layers: 0, alias: "tiny", pidFile: join(d, "server.json"), env: { ...process.env, FAKE_LLAMA_ARGS: argsFile } });
    if ("error" in s) throw new Error(s.error);
    killers.push(() => { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } });
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    expect(await (await fetch(`${s.url}/health`)).json()).toEqual({ status: "ok" });
    const given = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[] };
    expect(given.args).toEqual(argsOf({ model: join(d, "m.gguf"), window: 4096, layers: 0, alias: "tiny" }, s.port));
    expect(readNote(join(d, "server.json"))).toMatchObject({ pid: s.pid, port: s.port, binary: fakeBinary(d) });
    await s.stop();
    expect(alive(s.pid)).toBe(false);
    expect(existsSync(join(d, "server.json"))).toBe(false);
  });

  test("not ready before that line: a slow load is waited for", async () => {
    const d = dir();
    const s = await startServer({ binary: fakeBinary(d), model: "m", window: 1024, layers: 0, alias: "a", pidFile: join(d, "server.json"), env: { ...process.env, FAKE_LLAMA: "slow" } });
    if ("error" in s) throw new Error(s.error);
    expect(await (await fetch(`${s.url}/v1/models`)).json()).toMatchObject({ data: [{ id: "a" }] });
    await s.stop();
  });

  test("one that stops before it listens says the last thing it said that was an error, and leaves nothing behind", async () => {
    const d = dir();
    const s = await startServer({ binary: fakeBinary(d), model: "m", window: 1024, layers: 99, alias: "a", pidFile: join(d, "server.json"), env: { ...process.env, FAKE_LLAMA: "fail" } });
    expect(s).toEqual({ error: "The model did not start: srv load_model: error: failed to load model, out of memory" });
    expect(existsSync(join(d, "server.json"))).toBe(false);
  });

  test("one that never listens is given up on after the time allowed, and stopped", async () => {
    const d = dir();
    const s = await startServer({ binary: fakeBinary(d), model: "m", window: 1024, layers: 0, alias: "a", pidFile: join(d, "server.json"), loadMs: 600, env: { ...process.env, FAKE_LLAMA: "hang" } });
    expect(s).toEqual({ error: "The model took too long to load." });
    expect(existsSync(join(d, "server.json"))).toBe(false);
  });

  test("a program that is not there says so", async () => {
    const d = dir();
    const s = await startServer({ binary: join(d, "nothing"), model: "m", window: 1024, layers: 0, alias: "a", pidFile: join(d, "server.json") });
    expect("error" in s).toBe(true);
  });
});

describe.skipIf(win)("one that a program that crashed left behind", () => {
  const run = async (argv: string[]) => { const r = Bun.spawnSync(argv); return { code: r.exitCode ?? 1, output: r.stdout.toString() }; };

  test("is found by its note and stopped, and the note goes", async () => {
    const d = dir(), pidFile = join(d, "server.json");
    const s = await startServer({ binary: fakeBinary(d), model: "m", window: 1024, layers: 0, alias: "a", pidFile });
    if ("error" in s) throw new Error(s.error);
    killers.push(() => { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } });
    // The stand-in runs as the interpreter that its script starts, so that is the program the system names for it.
    writeFileSync(pidFile, JSON.stringify({ pid: s.pid, binary: process.execPath, port: s.port, startedAt: 1 }));
    expect(await reapOrphan(pidFile, run)).toBe("stopped");
    await until(() => !alive(s.pid));
    expect(existsSync(pidFile)).toBe(false);
  });

  test("a note of a process that is gone, and no note at all, leave nothing to do", async () => {
    const d = dir(), pidFile = join(d, "server.json");
    writeFileSync(pidFile, JSON.stringify({ pid: 2_000_000, binary: "/x/llama-server", port: 1, startedAt: 1 }));
    expect(await reapOrphan(pidFile, run)).toBe("none");
    expect(existsSync(pidFile)).toBe(false);
    expect(await reapOrphan(pidFile, run)).toBe("none");
  });

  test("a process that is not the program that was started is never stopped, only the note taken away", async () => {
    const d = dir(), pidFile = join(d, "server.json");
    const other = Bun.spawn(["sleep", "30"]);
    killers.push(() => other.kill());
    writeFileSync(pidFile, JSON.stringify({ pid: other.pid, binary: "/x/llama-server", port: 1, startedAt: 1 }));
    expect(await reapOrphan(pidFile, run)).toBe("not-ours");
    expect(alive(other.pid)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
    other.kill();
  });
});
