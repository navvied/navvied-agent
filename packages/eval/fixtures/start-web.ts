/**
 * Starts the fixture web in the background and leaves its address in the workspace (the folder this is run from): `.bench-port` and
 * `.bench-pid`. The server runs from the fixtures folder with the workspace only in its environment, so it is not taken for something the
 * agent left running. Bun only, so it is the same on every system.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = process.cwd();
const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = probe.port;
probe.stop(true);
writeFileSync(".bench-port", `${port}\n`);

const child = spawn(process.execPath, ["web-server.ts", String(port)], { cwd: import.meta.dir, env: { ...process.env, BENCH_OUT: out }, detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
writeFileSync(".bench-pid", `${child.pid}\n`);

// The server says "ready" once it listens, and the child ends if it cannot: this waits for one of the two, never for a number of seconds that a loaded machine can exceed.
const started = await new Promise<boolean>((done) => {
  child.stdout!.once("data", () => done(true));
  child.once("exit", () => done(false));
});
child.stdout!.destroy();
child.unref();
if (!started) { console.error("the fixture web did not start"); process.exit(1); }
process.exit(0);
