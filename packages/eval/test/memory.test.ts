import { describe, expect, test } from "bun:test";
import { watchMemory, type Process } from "../src/index.ts";

describe("watching memory", () => {
  test("the agent alone and the agent with everything it started, at the largest moment", () => {
    const tick = [
      [{ pid: 10, ppid: 1, rssKb: 100_000 }, { pid: 11, ppid: 10, rssKb: 50_000 }, { pid: 12, ppid: 11, rssKb: 30_000 }, { pid: 99, ppid: 1, rssKb: 900_000 }],
      [{ pid: 10, ppid: 1, rssKb: 120_000 }, { pid: 11, ppid: 10, rssKb: 10_000 }],
    ] satisfies Process[][];
    let n = 0;
    const w = watchMemory(10, 1_000_000, () => tick[Math.min(n++, 1)]);
    const peak = w.stop()!;
    expect(peak).toEqual({ agentMb: Math.round(120_000 / 1024), treeMb: Math.round(180_000 / 1024) });
  });
  test("the high-water mark the system keeps counts, though the process is smaller now", () => {
    const w = watchMemory(10, 1_000_000, () => [{ pid: 10, ppid: 1, rssKb: 10_240, peakKb: 204_800 }]);
    expect(w.stop()).toEqual({ agentMb: 200, treeMb: 10 });
  });
  test("where memory cannot be read nothing is claimed", () => {
    expect(watchMemory(10, 1_000_000, () => undefined).stop()).toBeUndefined();
  });
  test.skipIf(process.platform === "win32")("a real program that takes 150 MB is seen to, also when it is short-lived", async () => {
    const child = Bun.spawn([process.execPath, "-e", "const b = Buffer.alloc(150 * 1024 * 1024, 1); let s = 0; for (let i = 0; i < b.length; i += 4096) s += b[i]; setTimeout(() => {}, 400);"], { stdout: "ignore", stderr: "ignore" });
    const w = watchMemory(child.pid);
    await child.exited;
    const peak = w.stop()!;
    expect(peak.agentMb).toBeGreaterThan(140);
    expect(peak.treeMb).toBeGreaterThanOrEqual(peak.agentMb);
  });
});
