import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";

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

export interface Running { pid: number; parent: number; name: string; command: string }

const MOST_COMMAND = 160;
const MOST_HOLDERS = 8;
const LIST_MS = 15_000;
const WINDOWS_PROCESSES = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";

export function holdingFrom(processes: readonly Running[], dir: string, self: number, lister?: number): string[] {
  const parents = new Map(processes.map((p) => [p.pid, p.parent]));
  const descends = (pid: number, from: number): boolean => {
    const seen = new Set<number>();
    for (let at: number | undefined = parents.get(pid); at !== undefined && !seen.has(at); at = parents.get(at)) {
      if (at === from) return true;
      seen.add(at);
    }
    return false;
  };
  const isTheListing = (pid: number): boolean => lister !== undefined && (pid === lister || descends(pid, lister));
  return processes.filter((p) => p.pid !== self && !isTheListing(p.pid) && (descends(p.pid, self) || p.command.toLowerCase().includes(dir.toLowerCase()))).slice(0, MOST_HOLDERS).map((p) => `${p.pid} ${p.name}: ${p.command.slice(0, MOST_COMMAND)}`);
}

function windowsProcesses(): { processes: Running[]; lister: number } {
  const listed = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESSES], { encoding: "utf8", timeout: LIST_MS, maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) return { processes: [], lister: listed.pid };
  const rows = JSON.parse(listed.stdout) as { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }[];
  return { lister: listed.pid, processes: rows.map((r) => ({ pid: r.ProcessId, parent: r.ParentProcessId, name: r.Name, command: r.CommandLine ?? "" })) };
}

function windowsHolders(dir: string): string[] {
  const { processes, lister } = windowsProcesses();
  return holdingFrom(processes, dir, process.pid, lister);
}

function holders(dir: string): string[] {
  try {
    return process.platform === "win32" ? windowsHolders(dir) : stragglers(dir);
  } catch (e) {
    return [`they could not be listed: ${(e as Error).message}`];
  }
}

const naming = (e: unknown, dir: string): Error => {
  const found = holders(dir);
  return Object.assign(new Error(`${(e as Error).message}; maybe held by: ${found.length ? found.join(" | ") : "no program that could be named"}`), { code: (e as NodeJS.ErrnoException).code });
};

export function removeNow(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    throw naming(e, dir);
  }
}

export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const holding = stragglers(dir);
    try {
      if (holding.length) throw Object.assign(new Error(`still in use by: ${holding.join("; ")}`), { code: "EBUSY" });
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= 50 || !TRANSIENT.has((e as NodeJS.ErrnoException).code ?? "")) throw naming(e, dir);
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
