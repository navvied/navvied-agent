import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEFAULT_SANDBOX, Jobs, Sandbox, defaultTools, sandboxAbility } from "../src/index.ts";
import { refused } from "../src/sandbox/lookout.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { until } from "./helpers.ts";
import { outsideFolder } from "./outside.ts";

const base = mkdtempSync(join(tmpdir(), "navvied-look-test-"));
const project = join(base, "project");
mkdirSync(project, { recursive: true });
const sandbox = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: base });
const started: ChildProcess[] = [];
afterAll(hook("sandbox-look removes what it made", async () => { for (const c of started) c.kill("SIGKILL"); sandbox.close(); await removeTree(base); await removeTree(outsideProjectAndTemp); }), HOOK_MS);

const outsideProjectAndTemp = outsideFolder();
const works = process.platform === "linux" && sandboxAbility().how === "bubblewrap";

async function holder(): Promise<{ pid: number; port: number; tag: string }> {
  const file = join(base, `port-${started.length}`);
  const tag = `look-holder-${process.pid}-${started.length}-${Date.now()}`;
  const child = spawn("python3", ["-c", `import socket,time\ns=socket.socket()\ns.bind(("127.0.0.1",0))\ns.listen()\nopen(${JSON.stringify(file)},"w").write(str(s.getsockname()[1]))\ntime.sleep(120)`, tag], { stdio: "ignore" });
  started.push(child);
  await until(() => { try { return readFileSync(file, "utf8") !== ""; } catch { return false; } });
  return { pid: child.pid!, port: Number(readFileSync(file, "utf8")), tag };
}

function confined(command: string, box: Sandbox = sandbox): Promise<{ code: number | null; out: string }> {
  const launch = box.confine(["bash", "-c", command], { root: project, cwd: project, detached: true });
  if (!launch.confined) throw new Error(`not confined: ${launch.line}`);
  const env = { ...process.env, HOME: base, ...(launch.look ? { NAVVIED_LOOK: launch.look.dir, PATH: `${launch.look.bin}${delimiter}${process.env.PATH}` } : {}) };
  return new Promise((done) => {
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { out += d; });
    child.on("close", (code) => done({ code, out }));
  });
}

describe("the program of the person is seen from inside the sandbox", () => {
  test.skipIf(!works)("ps, pgrep, ss -p and lsof show a program that was started outside, and pgrep does not find itself", async () => {
    const { pid, port, tag } = await holder();
    await holder();
    const r = await confined(`ps -e -o pid,args | grep -E "^ *${pid} "; echo ---; pgrep -f "${tag.slice(0, 5)}""${tag.slice(5)}" | tr '\\n' ' '; echo ---; ss -ltnp | grep ":${port} "; echo ---; lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -n +2 | wc -l; echo ---; pgrep -f "no-such-""program-${port}"; echo "none-found=$?"`);
    const [ps, pgrep, ss, lsof, none] = r.out.split("---\n");
    expect(ps).toContain(`${pid} python3`);
    expect(pgrep!.trim().split(/\s+/)).toEqual([String(pid)]);
    expect(ss).toContain(`pid=${pid}`);
    expect(lsof!.trim()).toBe("1");
    expect(none).toContain("none-found=1");
  }, 30_000);

  test.skipIf(!works)("pkill by name stops that program and not the command that asked", async () => {
    const tag = `${process.pid}${Date.now() % 100000}`;
    const child = spawn("sleep", [`9${tag}`], { stdio: "ignore" });
    started.push(child);
    await until(() => child.pid !== undefined);
    const r = await confined(`pkill -f "sleep ""9${tag}"; echo "pkill=$?"; sleep 0.3; echo still-here`);
    expect(r.out).toContain("pkill=0");
    expect(r.out).toContain("still-here");
    await until(() => child.exitCode !== null || child.signalCode !== null);
    expect(child.signalCode).toBe("SIGTERM");
  }, 30_000);

  test.skipIf(!works)("what only looks is run, and what writes, kills or shows another program's environment is refused", async () => {
    const r = await confined(`ps eww 2>&1 | head -1; ss -K 2>&1 | head -1; lsof -D r 2>&1 | head -1; fuser -k 1/tcp 2>&1 | head -1; echo done`);
    expect(r.out).toContain("ps cannot show the environment");
    expect(r.out).toContain("ss may only look");
    expect(r.out).toContain("lsof may only look");
    expect(r.out).toContain("fuser may only look");
    expect(refused("ps", ["-e"])).toBeUndefined();
    expect(refused("ps", ["aux"])).toBeUndefined();
    expect(refused("rm", ["x"])).toContain("not available");
  }, 30_000);

  test.skipIf(!works)("what a command may write is the same as without the shims", async () => {
    const r = await confined(`echo x > ${join(outsideProjectAndTemp, "outside.txt")} && echo wrote || echo not-written`);
    expect(r.out).toContain("not-written");
  }, 30_000);

  test.skipIf(!works)("a job started in one call is seen in the next, also by another conversation's commands: the programs of the person are all visible", async () => {
    const tag = `${process.pid}${Date.now() % 100000}`;
    const first = await confined(`setsid sleep 8${tag} > /dev/null 2>&1 < /dev/null & echo $!`);
    const pid = Number(first.out.trim().split("\n").pop());
    expect(pid).toBeGreaterThan(1);
    started.push({ kill: () => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } } as ChildProcess);
    const next = await confined(`pgrep -f "sleep ""8${tag}" | tr '\\n' ' '; test -d /proc/${pid} && echo proc-dir`);
    expect(next.out).toContain(String(pid));
    expect(next.out).toContain("proc-dir");
    const other = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: base });
    try { expect((await confined(`pgrep -f "sleep ""8${tag}" | tr '\\n' ' '`, other)).out).toContain(String(pid)); } finally { other.close(); }
  }, 30_000);

  test.skipIf(!works)("through the Bash tool: the port holder is found by ss, the model is not told the port is free, and a job's own programs are seen in the next call", async () => {
    const { pid, port } = await holder();
    const jobs = new Jobs(() => undefined);
    const bash = defaultTools().find((t) => t.name === "Bash")!;
    const ctx = { cwd: project, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs, sandbox };
    const out = await bash.run({ command: `ss -ltnp | grep ":${port} "; fuser -n tcp ${port} 2>&1; echo "path=$(command -v ss)"` }, ctx);
    expect(out).toContain(`pid=${pid}`);
    expect(out).toContain(String(pid));
    expect(out).toContain("navvied-look-");
    expect(sandbox.confine(["true"], { root: project, cwd: project, detached: true }).line).not.toContain("not listed");
    jobs.close();
  }, 30_000);
});
