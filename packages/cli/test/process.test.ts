/** The real program, as a subprocess: entry point, exit codes, and the stdout/stderr split. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { encodeCommand, parseEvent } from "@navvied/protocol";
import { remove, startMockModel, tempDir } from "./helpers.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let mock: ReturnType<typeof startMockModel>;
const dirs: string[] = [];
beforeAll(() => { mock = startMockModel(); });
afterAll(() => { mock.stop(); dirs.forEach(remove); });

function env() {
  const state = tempDir(); dirs.push(state);
  return { PATH: process.env.PATH ?? "", HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "m", NAVVIED_WINDOW: "100000" };
}
const spawn = (args: string[], e = env(), stdin: "pipe" | "ignore" = "ignore") =>
  Bun.spawn(["bun", MAIN, ...args], { env: e, stdin, stdout: "pipe", stderr: "pipe" });

describe("the program", () => {
  test("--version prints a version and exits 0", async () => {
    const p = spawn(["--version"]);
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  test("run: the answer is alone on stdout, so it can be piped; exit 0", async () => {
    const p = spawn(["run", "hello"]);
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toBe("all done here\n");
    expect(await new Response(p.stderr).text()).toMatch(/Context \d+%/);
  });

  test("run: a failing model exits 1; a usage error exits 2", async () => {
    expect(await spawn(["run", "this will fail"]).exited).toBe(1);
    expect(await spawn(["run", "x", "--mode", "nope"]).exited).toBe(2);
  });

  test("serve --stdio: a real round trip over pipes, clean exit when stdin closes", async () => {
    const p = spawn(["serve", "--stdio"], env(), "pipe");
    p.stdin!.write(encodeCommand({ cmd: "prompt", text: "hello", qid: "q" }));
    await p.stdin!.flush();
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: string[] = [];
    while (!seen.includes("done")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (const line of buf.split("\n").slice(0, -1)) { const r = parseEvent(line); if (r.ok && !seen.includes(r.value.ev) || (r.ok && r.value.ev === "done")) seen.push(r.value.ev); }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    }
    p.stdin!.end();
    expect(await p.exited).toBe(0);
    expect(seen).toEqual(expect.arrayContaining(["session", "caps", "taken", "text", "usage", "done"]));
  });
});
