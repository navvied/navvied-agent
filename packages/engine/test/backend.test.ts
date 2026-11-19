import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, defaultTools, dockerBackend, localBackend, sshBackend } from "../src/index.ts";
import type { Backend } from "../src/backend.ts";
import type { ToolContext } from "../src/types.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-backend-"));
afterAll(hook("backend removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }));
const bash = defaultTools().find((t) => t.name === "Bash")!;
const ctx = (backend?: Backend): ToolContext => ({ cwd: dir, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), ...(backend ? { backend } : {}) });

describe("where Bash runs its commands", () => {
  test("on this computer when nothing else is chosen", async () => {
    expect(await bash.run({ command: "echo here" }, ctx())).toContain("here");
    expect(localBackend.id).toBe("local");
  });

  test("a container is made once, kept, and the command runs in it with the folder mounted", async () => {
    // A stand-in for docker that records what it was asked and runs the command here. It is a script for this runtime, which every
    // system can start (Windows cannot start a #! file).
    const log = join(dir, "docker.log");
    const fake = join(dir, "docker.js");
    writeFileSync(fake, [
      'const { appendFileSync } = require("node:fs");',
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");`,
      'if (args[0] === "inspect") process.exit(1);',
      'if (args[0] === "exec") { const r = Bun.spawnSync(args.slice(args.indexOf("sh")), { stdout: "inherit", stderr: "inherit" }); process.exit(r.exitCode ?? 1); }',
      "",
    ].join("\n"));
    const backend = dockerBackend({ program: [process.execPath, fake], image: "debian:stable-slim" });
    expect(await bash.run({ command: "echo in-the-box" }, ctx(backend))).toContain("in-the-box");
    expect(await bash.run({ command: "echo again" }, ctx(backend))).toContain("again");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter((l) => l.startsWith("run ")).length).toBe(1);
    expect(calls.find((l) => l.startsWith("run "))).toContain(`-v ${dir}:/work -w /work debian:stable-slim sleep infinity`);
    expect(calls.filter((l) => l.startsWith("exec ")).length).toBe(2);
  });

  test("a container that cannot be started is a sentence, not a crash", async () => {
    const fake = join(dir, "docker-broken.js");
    writeFileSync(fake, 'console.error("no such image"); process.exit(1);\n');
    const out = await bash.run({ command: "echo x" }, ctx(dockerBackend({ program: [process.execPath, fake], image: "nope" })));
    expect(out).toBe("Error: The container could not be started: no such image");
  });

  test("ssh runs the command on the other computer, quoted, in the folder given there", () => {
    const b = sshBackend({ host: "box.example", user: "me", dir: "/srv/it's here" });
    expect(b.prepare("ls -la", "/w").argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "me@box.example", "cd '/srv/it'\\''s here' && ls -la"]);
    expect(sshBackend({ host: "box.example" }).prepare("uptime", "/w").argv.at(-1)).toBe("uptime");
  });
});
