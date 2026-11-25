import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argsOf, readNote } from "../src/llama-server.ts";
import { parseMedia } from "../src/media-config.ts";
import { LocalVision, closeLocalVisions, localVision } from "../src/media-vision.ts";
import { remove, tempDir, until } from "./helpers.ts";

const dirs: string[] = [];
afterAll(async () => { await closeLocalVisions(); dirs.forEach(remove); });
const win = process.platform === "win32";

function setup() {
  const d = tempDir();
  dirs.push(d);
  const server = join(d, "llama-server");
  writeFileSync(server, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-llama.ts")}" "$@"\n`);
  chmodSync(server, 0o755);
  const model = join(d, "vlm.gguf"), mmproj = join(d, "mmproj.gguf");
  writeFileSync(model, "m"); writeFileSync(mmproj, "p");
  return { d, config: { server, model, mmproj }, pidFile: join(d, "vision-server.json") };
}
const handlers = { text() {}, thought() {}, toolStarted() {} };
const ask = async (v: LocalVision, q = "what is this?"): Promise<string> => (await v.stream({ system: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: q }, { type: "image", mime: "image/png", data: "AAAA" }] }] }, new AbortController().signal, handlers)).content;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("the picture model of this computer", () => {
  test("the reader of pictures is named to the server, and stays on the processor when no layer goes to a card", () => {
    expect(argsOf({ model: "/m.gguf", mmproj: "/p.gguf", window: 8192, layers: 0, alias: "vision" }, 0)).toEqual(["-m", "/m.gguf", "-c", "8192", "-ngl", "0", "--host", "127.0.0.1", "--port", "0", "--jinja", "-a", "vision", "-np", "1", "--mmproj", "/p.gguf", "--no-mmproj-offload"]);
    expect(argsOf({ model: "/m.gguf", mmproj: "/p.gguf", window: 8192, layers: 99, alias: "v" }, 0).slice(-2)).toEqual(["--mmproj", "/p.gguf"]);
    expect(argsOf({ model: "/m.gguf", window: 8192, layers: 0, alias: "v" }, 0)).not.toContain("--mmproj");
  });

  test("the configuration names the program, the model and the reader, in words when one is missing", () => {
    expect(parseMedia({ vision: { local: { server: "/s", model: "/m", mmproj: "/p" } } })).toEqual({ vision: { local: { server: "/s", model: "/m", mmproj: "/p" } } });
    expect(parseMedia({ vision: { local: { server: "/s", model: "/m" } } })).toContain('"media.vision.local" needs');
    expect(parseMedia({ vision: { model: "eyes" } })).toEqual({ vision: { model: "eyes" } });
    expect(parseMedia({ image: { bin: "/s", model: "/m", steps: 1, cfg: 1 } })).toEqual({ image: { bin: "/s", model: "/m", steps: 1, cfg: 1 } });
    expect(parseMedia({ image: { bin: "/s", model: "/m", steps: 1.5 } })).toContain('"media.image.steps"');
  });

  test.skipIf(win)("nothing runs until the first question; the same server answers the next; closing stops it", async () => {
    const { config, pidFile } = setup();
    const v = localVision(config, pidFile)!;
    expect(v).toBeInstanceOf(LocalVision);
    expect(existsSync(pidFile)).toBe(false);
    expect(await ask(v)).toBe("hello");
    const first = readNote(pidFile)!;
    expect(alive(first.pid)).toBe(true);
    await ask(v, "again");
    expect(readNote(pidFile)!.pid).toBe(first.pid);
    expect(localVision(config, pidFile)).toBe(v);
    await v.close();
    expect(alive(first.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  test.skipIf(win)("an idle server is stopped by itself", async () => {
    const { config, pidFile } = setup();
    const v = new LocalVision(config, { pidFile, idleMs: 100 });
    await ask(v);
    const pid = readNote(pidFile)!.pid;
    await until(() => !alive(pid), 10_000);
  });

  test("a file that is missing means no model is offered, and a server that cannot start says why", async () => {
    const { config, pidFile, d } = setup();
    expect(localVision({ ...config, mmproj: join(d, "gone.gguf") }, pidFile)).toBeUndefined();
    if (win) return;
    process.env.FAKE_LLAMA = "fail";
    try {
      const v = new LocalVision(config, { pidFile });
      await expect(ask(v)).rejects.toThrow(/did not start/);
    } finally { delete process.env.FAKE_LLAMA; }
    expect(readFileSync(config.model, "utf8")).toBe("m");
  });
});
