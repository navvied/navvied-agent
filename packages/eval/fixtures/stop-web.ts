/** Stops the fixture web that `start-web.ts` left in this folder. Nothing to stop is not a failure. */
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".bench-pid")) {
  try { process.kill(Number(readFileSync(".bench-pid", "utf8").trim())); } catch { /* already gone */ }
}
