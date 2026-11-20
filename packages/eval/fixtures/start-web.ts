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

const child = spawn(process.execPath, ["web-server.ts", String(port)], { cwd: import.meta.dir, env: { ...process.env, BENCH_OUT: out }, detached: true, stdio: "ignore", windowsHide: true });
child.unref();
writeFileSync(".bench-pid", `${child.pid}\n`);

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) process.exit(0); } catch { /* not listening yet */ }
  await Bun.sleep(100);
}
console.error("the fixture web did not start");
process.exit(1);
