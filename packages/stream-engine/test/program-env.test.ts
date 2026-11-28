import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEngine } from "@navvied/engine";
import type { EngineEvent } from "@navvied/protocol";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { until } from "../../engine/test/helpers.ts";
import { CodexEngine, StreamEngine } from "../src/index.ts";

const secrets = { NAVVIED_PROBE_API_KEY: "probe-key-0123456789abcdef", NAVVIED_PROBE_SIGNIN_TOKEN: "probe-signin-0123456789abcdef" };
const dir = mkdtempSync(join(tmpdir(), "navvied-programenv-"));
beforeAll(() => { Object.assign(process.env, secrets); });
afterAll(hook("program-env removes what it made", async () => { for (const name of Object.keys(secrets)) delete process.env[name]; await removeTree(dir); }), HOOK_MS);

describe.skipIf(process.platform === "win32")("what a program the person is signed in to is given", () => {
  for (const Program of [StreamEngine, CodexEngine]) {
    const name = Program.name;
    test(`${name}: its own sign-in and its entry's variables, none of the other keys`, async () => {
      const out = join(dir, `${name}.env`), script = join(dir, `${name}.sh`);
      writeFileSync(script, `#!/bin/sh\nenv > ${JSON.stringify(out)}\n`);
      chmodSync(script, 0o755);
      const events: EngineEvent[] = [];
      const engine: AgentEngine = new Program({ command: script, cwd: dir, emit: (e: EngineEvent) => { events.push(e); }, signIn: ["NAVVIED_PROBE_SIGNIN_TOKEN"], env: { NAVVIED_PROBE_SET_BY_ENTRY: "1" } } as never);
      engine.handle({ cmd: "prompt", text: "go", mode: "auto" });
      await until(() => events.some((e) => e.ev === "done"));
      engine.close();
      expect(readFileSync(out, "utf8").split("\n").map((l) => l.split("=")[0]!).filter((n) => n.startsWith("NAVVIED_PROBE")).sort()).toEqual(["NAVVIED_PROBE_SET_BY_ENTRY", "NAVVIED_PROBE_SIGNIN_TOKEN"]);
    });
  }
});
