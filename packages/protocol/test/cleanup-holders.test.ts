import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdingFrom, removeNow } from "./support/cleanup.ts";

describe("a folder a test cannot remove says who may be holding it", () => {
  const processes = [
    { pid: 10, parent: 1, name: "bun.exe", command: "bun test" },
    { pid: 11, parent: 10, name: "helper.exe", command: "helper serve" },
    { pid: 12, parent: 11, name: "node.exe", command: "node watch.js" },
    { pid: 20, parent: 1, name: "editor.exe", command: 'editor "C:\\Temp\\navvied-cli-ab12\\notes.txt"' },
    { pid: 30, parent: 1, name: "agent.exe", command: "agent --service" },
  ];

  test("the programs the tests started, however deep, and any whose command names the folder; no other program of the computer", () => {
    expect(holdingFrom(processes, "C:\\Temp\\navvied-cli-ab12", 10)).toEqual(["11 helper.exe: helper serve", "12 node.exe: node watch.js", '20 editor.exe: editor "C:\\Temp\\navvied-cli-ab12\\notes.txt"']);
  });

  test("the program that lists them, and what it started, is never named as a holder", () => {
    const listing = [...processes, { pid: 40, parent: 10, name: "powershell.exe", command: "powershell -Command Get-CimInstance Win32_Process" }, { pid: 41, parent: 40, name: "conhost.exe", command: "conhost" }];
    expect(holdingFrom(listing, "C:\\Temp\\none", 10, 40)).toEqual(["11 helper.exe: helper serve", "12 node.exe: node watch.js"]);
  });

  test("a long command is cut and a loop of parents ends", () => {
    const odd = [{ pid: 2, parent: 3, name: "a", command: "x".repeat(900) }, { pid: 3, parent: 2, name: "b", command: "y" }];
    const found = holdingFrom(odd, "/t/none", 1);
    expect(found).toEqual([]);
    expect(holdingFrom([{ pid: 2, parent: 1, name: "a", command: "x".repeat(900) }], "/t/none", 1)[0]!.length).toBeLessThanOrEqual(220);
  });

  test.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("the failure to remove carries the names", async () => {
    const outer = mkdtempSync(join(tmpdir(), "navvied-hold-"));
    const held = join(outer, "held");
    mkdirSync(held);
    writeFileSync(join(held, "f"), "x");
    const child = spawn("sleep", ["30"], { cwd: held, stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    chmodSync(held, 0o500);
    try {
      expect(() => removeNow(held)).toThrow(/maybe held by: .*sleep 30/);
    } finally {
      chmodSync(held, 0o700);
      child.kill("SIGKILL");
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
