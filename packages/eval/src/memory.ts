import { readdirSync, readFileSync } from "node:fs";

export interface Process { pid: number; ppid: number; rssKb: number; /** The highest the system has seen it use, where it says. */ peakKb?: number }

/** Every process on the computer with its parent and resident memory; nothing where that cannot be read (Windows). */
export function processes(): Process[] | undefined {
  if (process.platform === "linux") {
    const out: Process[] = [];
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid)) continue;
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const field = (key: string): number => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
        out.push({ pid, ppid: field("PPid"), rssKb: field("VmRSS"), peakKb: field("VmHWM") });
      } catch { /* ended meanwhile */ }
    }
    return out;
  }
  if (process.platform === "win32") return undefined;
  const r = Bun.spawnSync(["ps", "-Ao", "pid=,ppid=,rss="], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return undefined;
  return r.stdout.toString().trim().split("\n").flatMap((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    return pid !== undefined && ppid !== undefined && rss !== undefined && Number.isFinite(rss) ? [{ pid, ppid, rssKb: rss }] : [];
  });
}

export interface MemoryPeak { /** The agent process alone. */ agentMb: number; /** The agent and everything it started, at the moment that was largest. */ treeMb: number }

/** The highest memory the system has seen one process use, read from its own record where it keeps one (Linux). */
function highWaterKb(pid: number): number | undefined {
  if (process.platform !== "linux") {
    // No high-water mark: the process is looked at as often as is cheap (one `ps` for one process).
    if (process.platform === "win32") return undefined;
    const r = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const kb = Number(r.stdout.toString().trim());
    return r.exitCode === 0 && Number.isFinite(kb) ? kb : undefined;
  }
  try { return Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]); } catch { return undefined; }
}

/**
 * Watches a process and what it starts, and gives the highest memory seen when stopped (nothing where memory cannot be read).
 * The tree is looked at every `everyMs`. The agent alone is looked at more often: every 20 ms where the system keeps a high-water mark
 * for a process (Linux), so a short run that grows fast is not missed, and every 50 ms elsewhere, where a process that lives a
 * tenth of a second may still be missed.
 */
export function watchMemory(pid: number, everyMs = 200, list: () => Process[] | undefined = processes): { stop(): MemoryPeak | undefined } {
  let agent = 0, tree = 0, seen = false;
  const sample = (): void => {
    const all = list();
    if (!all) return;
    seen = true;
    const children = new Map<number, Process[]>();
    for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
    const self = all.find((p) => p.pid === pid);
    if (self) agent = Math.max(agent, self.rssKb, self.peakKb ?? 0);
    let sum = 0;
    const walk = (p: Process, depth: number): void => { sum += p.rssKb; if (depth < 12) for (const c of children.get(p.pid) ?? []) walk(c, depth + 1); };
    if (self) walk(self, 0);
    tree = Math.max(tree, sum);
  };
  const quick = (): void => { const kb = highWaterKb(pid); if (kb !== undefined && Number.isFinite(kb)) { agent = Math.max(agent, kb); tree = Math.max(tree, kb); seen = true; } };
  sample();
  const timer = setInterval(sample, everyMs);
  const fast = list === processes ? setInterval(quick, process.platform === "linux" ? 20 : 50) : undefined;
  return { stop: () => { clearInterval(timer); if (fast) clearInterval(fast); quick(); sample(); return seen ? { agentMb: Math.round(agent / 1024), treeMb: Math.round(tree / 1024) } : undefined; } };
}
