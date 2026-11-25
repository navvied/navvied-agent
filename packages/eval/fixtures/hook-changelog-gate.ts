/** A Stop hook for the offline hook tasks: the turn may not end while CHANGELOG.md has no entry for the version in VERSION. It asks once; a second stop is allowed. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const call = JSON.parse(await Bun.stdin.text()) as { cwd?: string; stop_hook_active?: boolean };
const dir = call.cwd ?? process.cwd();
const read = (name: string): string => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
const version = read("VERSION").trim();
if (!call.stop_hook_active && version && !new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m").test(read("CHANGELOG.md"))) {
  console.log(JSON.stringify({ decision: "block", reason: `CHANGELOG.md has no "## ${version}" section; add it with a line about the change, then finish` }));
}
