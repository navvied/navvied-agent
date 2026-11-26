import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTools, executeCode } from "../src/index.ts";
import { serveCalls } from "../src/tools/code-rpc.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";
import { HOOK_MS as REMOVE_MS, removeTree } from "../../protocol/test/support/cleanup.ts";

const likeWindows = mkdtempSync(join(tmpdir(), "navvied-code-windows-"));
const before = process.env.PYTHONPATH;
beforeAll(() => {
  writeFileSync(join(likeWindows, "sitecustomize.py"), 'import socket, sys\nif hasattr(socket, "AF_UNIX"):\n    del socket.AF_UNIX\nsys.stdout.reconfigure(newline="\\r\\n", encoding="cp1252")\nsys.stdin.reconfigure(encoding="cp1252")\n');
});
afterAll(cleanupAll, HOOK_MS);
afterAll(async () => { await removeTree(likeWindows); }, REMOVE_MS);

describe("a script on a system without Unix sockets, whose Python writes other line ends and another code page", () => {
  test.skipIf(process.platform === "win32")("runs to its end, calls the tools, and keeps every character", async () => {
    process.env.PYTHONPATH = likeWindows;
    try {
      const tools = [...defaultTools().filter((t) => t.name !== "ExecuteCode"), executeCode];
      const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "ExecuteCode", args: { code: 'from navvied_tools import *\nwrite("note.txt", "café ✓ 数\\n")\nprint(read("note.txt").strip())\nprint("done ✓")' } }] } : { text: "ok" }), { tools, toolOn: () => true });
      await r.turn(prompt("go", { mode: "auto" }), 20_000);
      const said = r.of("tool").find((e) => e.name === "ExecuteCode" && e.status !== "running")!.output!;
      expect(said).toBe("café ✓ 数\ndone ✓");
    } finally {
      if (before === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = before;
    }
  }, 60_000);
});

describe("the secret of a script is kept where another person on this computer cannot read it", () => {
  const LOOK = [
    "import os, subprocess, navvied_tools",
    "from navvied_tools import glob",
    "glob('*')",
    "secret = navvied_tools._door[1]",
    "shown = subprocess.check_output(['ps', '-ww', '-o', 'command=', '-p', str(os.getpid())]).decode()",
    "folder = os.environ['NAVVIED_CODE_DIR']",
    "files = [os.path.join(at, name) for at, _, names in os.walk(folder) for name in names]",
    "print('command line seen:', 'navvied_tools' in shown, 'has secret:', secret in shown)",
    "print('environment has secret:', any(secret in value for value in os.environ.values()))",
    "print('files seen:', len(files) > 0, 'have secret:', any(secret.encode() in open(f, 'rb').read() for f in files))",
    "print('folder closed to others:', os.stat(folder).st_mode & 0o077 == 0)",
  ].join("\n");

  test.skipIf(process.platform === "win32")("it is in no command line, environment or file, and the script's folder is its owner's only", async () => {
    const tools = [...defaultTools().filter((t) => t.name !== "ExecuteCode"), executeCode];
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "ExecuteCode", args: { code: LOOK } }] } : { text: "ok" }), { tools, toolOn: () => true });
    await r.turn(prompt("go", { mode: "auto" }), 20_000);
    const said = r.of("tool").find((e) => e.name === "ExecuteCode" && e.status !== "running")!.output!;
    expect(said).toBe("command line seen: True has secret: False\nenvironment has secret: False\nfiles seen: True have secret: False\nfolder closed to others: True");
  }, 60_000);
});

describe("the calls of a script are taken only from the script", () => {
  const ask = (port: number, lines: string[]): Promise<string> => new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(lines.map((l) => `${l}\n`).join("")));
    let heard = "";
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => { heard += d; if (heard.endsWith("\n")) { socket.end(); resolve(heard); } });
    socket.on("close", () => resolve(heard));
    socket.on("error", () => resolve(heard));
  });
  const call = JSON.stringify({ tool: "Read", args: {} });

  test("a connection that does not begin with the script's own secret is closed and nothing is run", async () => {
    let ran = 0;
    const server = await serveCalls(async () => { ran++; return { ok: true, text: "text" }; }, 5);
    try {
      for (const lines of [[call], ["", call], ["x".repeat(server.token.length), call], [server.token.slice(0, -1), call], [`${server.token}x`, call], ["x".repeat(5_000)]]) expect(await ask(server.port, lines)).toBe("");
      expect(ran).toBe(0);
      expect(server.used()).toBe(0);
      expect(JSON.parse(await ask(server.port, [server.token, call]))).toEqual({ ok: true, text: "text" });
      expect(ran).toBe(1);
    } finally { server.close(); }
  });

  test("each script has a secret of its own, long enough not to be guessed, and the door is open on this computer only", async () => {
    const one = await serveCalls(async () => ({ ok: true, text: "" }), 1), two = await serveCalls(async () => ({ ok: true, text: "" }), 1);
    try {
      expect(one.token).not.toBe(two.token);
      expect(one.token.length).toBeGreaterThanOrEqual(43);
      expect(one.address).toBe("127.0.0.1");
    } finally { one.close(); two.close(); }
  });

  test("closing ends the connections that are still open", async () => {
    const server = await serveCalls(async () => ({ ok: true, text: "" }), 1);
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`${server.token}\n`);
    const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => undefined);
    socket.write(`${call}\n`);
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    server.close();
    await ended;
  });
});
