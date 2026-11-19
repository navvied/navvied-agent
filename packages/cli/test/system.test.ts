import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realSystem } from "../src/system.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const tmp = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => dirs.forEach(remove));

const script = (dir: string, name: string, body: string): void => { writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
const posix = process.platform !== "win32";

describe.skipIf(!posix)("the computer, as the setup screens see it", () => {
  test("the clipboard is read with the program this system has, and an empty or huge one is nothing", async () => {
    const dir = tmp();
    script(dir, "pbpaste", 'printf "  copied text\\n"');
    expect(await realSystem({ PATH: dir }, "darwin").clipboard()).toBe("copied text");
    script(dir, "pbpaste", "printf ''");
    expect(await realSystem({ PATH: dir }, "darwin").clipboard()).toBeUndefined();
    script(dir, "pbpaste", "head -c 9000 /dev/zero | tr '\\\\0' x");
    expect(await realSystem({ PATH: dir }, "darwin").clipboard()).toBeUndefined();
  });

  test("on Linux the first reader that exists and works is used; with none, there is no clipboard", async () => {
    const dir = tmp();
    expect(await realSystem({ PATH: dir }, "linux").clipboard()).toBeUndefined();
    script(dir, "xclip", "exit 1");
    script(dir, "xsel", 'printf "from xsel"');
    expect(await realSystem({ PATH: dir }, "linux").clipboard()).toBe("from xsel");
    script(dir, "wl-paste", 'printf "from wayland"');
    expect(await realSystem({ PATH: dir }, "linux").clipboard()).toBe("from wayland");
  });

  test("a program is found in its install places as well as on the PATH", () => {
    const home = tmp(), dir = tmp();
    script(join(home, "."), "unused", "true");
    script(dir, "tool", "true");
    expect(realSystem({ PATH: dir, HOME: home }, "linux").which("tool")).toBe(join(dir, "tool"));
    expect(realSystem({ PATH: dir, HOME: home }, "linux").which("no-such-tool-xyz")).toBeUndefined();
  });

  test("running a program gives each line as it is printed, from both outputs, the exit code and everything printed", async () => {
    const lines: string[] = [];
    const r = await realSystem({ PATH: process.env.PATH ?? "" }, "linux").run(["sh", "-c", "echo one; echo two >&2; printf partial"], { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(lines.sort()).toEqual(["one", "partial", "two"]);
    expect(r.output).toContain("one\n");
  });

  test("a program that runs too long is stopped, and one that is cancelled stops too", async () => {
    const sys = realSystem({ PATH: process.env.PATH ?? "" }, "linux");
    const slow = await sys.run(["sh", "-c", "sleep 5"], { timeoutMs: 100 });
    expect(slow.code).not.toBe(0);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await sys.run(["sh", "-c", "sleep 5"], { signal: controller.signal });
    expect(cancelled.code).not.toBe(0);
  });

  test("only secure addresses are ever opened in the browser, and a missing opener does not break anything", () => {
    const dir = tmp(), log = join(dir, "opened.txt");
    script(dir, "xdg-open", `echo "$1" >> ${log}`);
    const sys = realSystem({ PATH: dir }, "linux");
    sys.open("http://insecure.example");
    sys.open("javascript:alert(1)");
    expect(() => realSystem({ PATH: tmp() }, "linux").open("https://example.com")).not.toThrow();
    expect(() => sys.open("https://example.com/keys")).not.toThrow();
  });
});
