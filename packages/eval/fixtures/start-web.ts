/**
 * Starts the fixture web in the background and leaves its address in the workspace (the folder this is run from): `.bench-port` and
 * `.bench-pid`. The server runs from the fixtures folder with the workspace only in its environment, so it is not taken for something the
 * agent left running. Bun only, so it is the same on every system.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = process.cwd();
const child = spawn(process.execPath, ["web-server.ts"], { cwd: import.meta.dir, env: { ...process.env, BENCH_OUT: out }, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
writeFileSync(".bench-pid", `${child.pid}\n`);

// The server says "ready <port>" once it listens, and the child ends if it cannot: this waits for one of the two, never for a number of seconds that a loaded machine can exceed.
let said = "";
let failure = "";
child.stderr!.on("data", (d) => { failure += d; });
const port = await new Promise<number | null>((done) => {
  child.stdout!.on("data", (d) => { said += d; const m = /ready (\d+)/.exec(said); if (m) done(Number(m[1])); });
  child.once("exit", (code, signal) => { failure += `\nthe server ended with ${signal ?? `exit code ${code}`}`; done(null); });
});
if (port === null) { console.error(`the fixture web did not start: ${failure.trim().slice(-600)}`); process.exit(1); }
writeFileSync(".bench-port", `${port}\n`);
child.stdout!.destroy();
child.stderr!.destroy();
child.unref();
process.exit(0);
