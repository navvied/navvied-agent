import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX, Sandbox, sandboxAbility } from "../src/index.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const base = mkdtempSync(join(tmpdir(), "navvied-visible-"));
const project = join(base, "project");
mkdirSync(project, { recursive: true });
const sandbox = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: base });
afterAll(hook("sandbox-visible removes what it made", async () => { sandbox.close(); await removeTree(base); }), HOOK_MS);

const works = process.platform === "linux" && sandboxAbility().how === "bubblewrap";

/** One confined command, started the way a job is (not ended with this program, so nothing has to be released). */
function confined(command: string): { code: number | null; out: string } {
  const launch = sandbox.confine(["bash", "-c", command], { root: project, cwd: project, detached: true });
  if (!launch.confined) throw new Error(`not confined: ${launch.line}`);
  const r = spawnSync(launch.argv[0]!, launch.argv.slice(1), { cwd: project, encoding: "utf8", env: { ...process.env, HOME: base } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("the commands of one conversation see each other's programs", () => {
  test.skipIf(!works)("a job started by one command is in ps and /proc in the next, and pkill by name stops it", () => {
    const tag = `${process.pid}${Date.now() % 100000}`;
    const started = confined(`setsid sleep 3${tag} >/dev/null 2>&1 < /dev/null & echo $!`);
    const pid = Number(started.out.trim().split("\n").pop());
    expect(pid).toBeGreaterThan(1);
    const seen = confined(`ps -eo comm,args | awk '$1=="sleep" && $3=="3${tag}"' | wc -l; test -d /proc/${pid} && echo proc-visible; pgrep -x sleep | head -3`);
    expect(seen.out).toContain("1\n");
    expect(seen.out).toContain("proc-visible");
    expect(seen.out).toContain(String(pid));
    const killed = confined(`pkill -f "^sleep 3${tag}$" && echo killed; sleep 0.3; ps -eo comm,args | awk '$1=="sleep" && $3=="3${tag}"' | wc -l`);
    expect(killed.out).toContain("killed");
    expect(killed.out.trim().endsWith("0")).toBe(true);
  }, 30_000);

  test.skipIf(!works)("what one conversation started stays invisible to another", () => {
    const other = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: base });
    const tag = `${process.pid}${Date.now() % 100000}x`;
    try {
      confined(`setsid sleep 4${tag.replace("x", "")} >/dev/null 2>&1 < /dev/null &`);
      const launch = other.confine(["bash", "-c", `ps -eo comm,args | awk '$1=="sleep" && $3=="4${tag.replace("x", "")}"' | wc -l`], { root: project, cwd: project, detached: true });
      if (!launch.confined) throw new Error("not confined");
      const r = spawnSync(launch.argv[0]!, launch.argv.slice(1), { cwd: project, encoding: "utf8" });
      expect(r.stdout.trim()).toBe("0");
    } finally { other.close(); for (const pid of spawnSync("pgrep", ["-f", `^sleep 4${tag.replace("x", "")}$`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ } } }
  }, 30_000);
});
