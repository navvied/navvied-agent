import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAbility } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const project = mkdtempSync(join(tmpdir(), "navvied-look-release-"));
const started: ChildProcess[] = [];
afterAll(hook("lookout-release removes what it made", async () => { for (const program of started) program.kill("SIGKILL"); await removeTree(project); }), HOOK_MS);

const works = process.platform === "linux" && sandboxAbility().how === "bubblewrap";

function ranToItsEnd(how: "engine" | "two sandboxes"): Promise<{ code: number | null; said: string }> {
  const program = spawn("bun", [join(import.meta.dir, "lookout-program.ts"), project, how], { stdio: ["ignore", "pipe", "ignore"] });
  started.push(program);
  let said = "";
  program.stdout!.on("data", (chunk) => { said += chunk; });
  return new Promise((done) => program.once("close", (code) => done({ code, said })));
}

describe("what lets a sandboxed command see the person's programs is let go with the last sandbox", () => {
  test.skipIf(!works)("a program that uses the engine exits by itself after a sandboxed command", async () => {
    const { code, said } = await ranToItsEnd("engine");
    expect(said).toContain("navvied-look-");
    expect(said).toContain("listed");
    expect(code).toBe(0);
  }, 30_000);

  test.skipIf(!works)("closing one sandbox keeps it for the others, closing the last removes its folder, and the next command sets it up again", async () => {
    expect(await ranToItsEnd("two sandboxes")).toEqual({ code: 0, said: "same folder: true\nkept for the other: true\ngone with the last: true\nset up again: true\n" });
  }, 30_000);
});
