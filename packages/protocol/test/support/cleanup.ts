import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { rm } from "node:fs/promises";

/**
 * Removing what a test made. A folder cannot be removed on Windows while a program that was started in it is still exiting, or while a
 * file in it is open; those errors pass, so the removal is tried again for a few seconds before it is called a failure.
 */
const TRANSIENT = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES", "EMFILE", "ENFILE"]);

/**
 * The programs still running with `dir` as their folder, as `pid name`. Linux lets a folder be removed under a running program, Windows does
 * not, so a test that leaves one behind would pass here and fail there; looking for them makes it fail here too. Nothing to look with elsewhere.
 */
export function stragglers(dir: string): string[] {
  if (process.platform !== "linux") return [];
  const found: string[] = [];
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === dir || cwd.startsWith(`${dir}/`)) found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim().slice(0, 80)}`);
    } catch { /* gone, or not ours to look at */ }
  }
  return found;
}

export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const holding = stragglers(dir);
    try {
      if (holding.length) throw Object.assign(new Error(`still in use by: ${holding.join("; ")}`), { code: "EBUSY" });
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 50 || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      await Bun.sleep(100);
    }
  }
}

export const removeTrees = (dirs: Iterable<string>): Promise<void> => Promise.all([...dirs].map(removeTree)).then(() => undefined);

/**
 * How long a cleanup hook may take. The test runner stops a hook after 5 s unless it is told otherwise, and a folder that Windows still holds
 * is tried again for about that long, so a hook is given the time its own work needs and says which hook it is when that is not enough.
 * Pass it as the second argument: `afterAll(hook("name", fn), HOOK_MS)`.
 */
export const HOOK_MS = 60_000;

/**
 * A hook that names itself when it fails. The test runner calls a failed hook "(unnamed)", which says nothing on a computer one cannot
 * log in to; this prints a line the CI turns into an annotation (a workflow command) with the name and the reason, and fails as before.
 */
export function hook(name: string, fn: () => unknown, ms = HOOK_MS - 2000): () => Promise<void> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([fn(), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`still running after ${ms / 1000} s`)), ms); })]);
    } catch (e) {
      const reason = e instanceof Error ? `${e.name}${(e as NodeJS.ErrnoException).code ? ` ${(e as NodeJS.ErrnoException).code}` : ""}: ${e.message}` : String(e);
      console.log(`::error title=hook failed: ${name.replace(/[,:\r\n]/g, " ")}::${reason.replace(/[\r\n]+/g, " ").replace(/%/g, "%25")}`);
      console.error(`hook failed: ${name}: ${reason}`);
      throw e;
    } finally { clearTimeout(timer); }
  };
}
