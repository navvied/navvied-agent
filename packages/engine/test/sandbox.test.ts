import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX, Jobs, Sandbox, defaultTools, killTree, sandboxAbility, stopAllJobs, type SandboxSetting } from "../src/index.ts";
import { denialIn, planFor, seatbeltProfile, seccompProgram, bubblewrapArgs } from "../src/sandbox/index.ts";
import { DENIED_CALLS } from "../src/sandbox/seccomp.ts";
import { SECRET_DIRS, isSecretPath } from "../src/secret-stores.ts";
import type { ToolContext } from "../src/types.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { run } from "../src/tools/util.ts";
import { cleanupAll, prompt, rig, until, wait } from "./helpers.ts";
import { outsideFolder } from "./outside.ts";

const base = mkdtempSync(join(tmpdir(), "navvied-sandbox-test-"));
const home = join(base, "home");
const project = join(base, "home", "project");
const away = outsideFolder();
mkdirSync(project, { recursive: true });
afterAll(hook("sandbox removes what it made", async () => { await stopAllJobs(); await removeTree(base); await removeTree(away); }), HOOK_MS);
afterAll(cleanupAll, HOOK_MS);

const linux = process.platform === "linux";
const works = linux && sandboxAbility().how === "bubblewrap";
const setting = (s: Partial<SandboxSetting> = {}) => () => ({ ...DEFAULT_SANDBOX, ...s });
const sandbox = (s: Partial<SandboxSetting> = {}, o: { hide?: string[] } = {}) => new Sandbox({ setting: setting(s), home, ...(o.hide ? { hide: () => o.hide! } : {}) });

/** Runs a shell command confined, the way the Bash tool starts one (as a job that is not ended with its parent: this call has no program to release a guard). */
function confined(command: string, s: Partial<SandboxSetting> = {}, o: { hide?: string[]; cwd?: string } = {}): { code: number | null; out: string; line: string } {
  const cwd = o.cwd ?? project;
  const launch = sandbox(s, o).confine(["bash", "-c", command], { root: project, cwd, detached: true });
  if (!launch.confined) throw new Error(`not confined: ${launch.line}`);
  const r = spawnSync(launch.argv[0]!, launch.argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, line: launch.line };
}

describe("the list of secret places is one list", () => {
  test("the folders, files and browser profiles are secret wherever they are; an example env file is not", () => {
    for (const d of SECRET_DIRS) expect(isSecretPath(`/home/u/${d}/x`), d).toBe(true);
    expect(isSecretPath("/home/u/.netrc")).toBe(true);
    expect(isSecretPath("/home/u/.config/google-chrome/Default/Login Data")).toBe(true);
    expect(isSecretPath("/home/u/.mozilla/firefox/a.default/logins.json")).toBe(true);
    expect(isSecretPath("/work/app/.env")).toBe(true);
    expect(isSecretPath("/work/app/.env.production")).toBe(true);
    expect(isSecretPath("/work/app/.env.example")).toBe(false);
    expect(isSecretPath("/work/app/src/index.ts")).toBe(false);
  });
});

describe("the system call filter", () => {
  /** What the kernel would do with a call: the filter run as the small machine it is. */
  function verdict(program: Uint8Array, arch: number, nr: number): number {
    const v = new DataView(program.buffer, program.byteOffset);
    let acc = 0, pc = 0;
    for (let steps = 0; steps < 1000; steps++) {
      const code = v.getUint16(pc * 8, true), jt = v.getUint8(pc * 8 + 2), jf = v.getUint8(pc * 8 + 3), k = v.getUint32(pc * 8 + 4, true);
      if (code === 0x20) { acc = k === 4 ? arch : k === 0 ? nr : -1; pc++; }
      else if (code === 0x15) pc += 1 + (acc === k ? jt : jf);
      else if (code === 0x35) pc += 1 + (acc >= k ? jt : jf);
      else if (code === 0x06) return k;
      else throw new Error(`unknown instruction ${code}`);
    }
    throw new Error("the filter does not end");
  }
  const ALLOW = 0x7fff0000, EPERM = 0x00050001, ENOSYS = 0x00050026;

  test("every call of the list is refused, every other one goes through, on both processors", () => {
    for (const [arch, audit] of [["x64", 0xc000003e], ["arm64", 0xc00000b7]] as const) {
      const program = seccompProgram(arch)!;
      expect(program.length % 8).toBe(0);
      const numbers = Object.values(DENIED_CALLS[arch]);
      for (const n of numbers) expect(verdict(program, audit, n), `${arch} ${n}`).toBe(EPERM);
      for (const n of [0, 1, 2, 3, 9, 56, 59, 231, 257, ...numbers.map((x) => x + 1)].filter((x) => !numbers.includes(x))) expect(verdict(program, audit, n), `${arch} ${n}`).toBe(ALLOW);
    }
  });

  test("a call in another system call convention is refused whole, not looked up in the wrong table", () => {
    const x64 = seccompProgram("x64")!;
    expect(verdict(x64, 0x40000003, 101)).toBe(ENOSYS);
    expect(verdict(x64, 0xc000003e, 0x40000000 | 1)).toBe(ENOSYS);
    expect(verdict(seccompProgram("arm64")!, 0xc000003e, 1)).toBe(ENOSYS);
    expect(seccompProgram("riscv64")).toBeUndefined();
  });

  test.skipIf(!linux || process.arch !== "x64" || spawnSync("gcc", ["--version"]).status !== 0)("the numbers are the ones of this system's own header (x86-64)", () => {
    const names = Object.keys(DENIED_CALLS.x64);
    const c = `#include <stdio.h>\n#include <sys/syscall.h>\nint main(void){${names.map((n) => `printf("${n} %d\\n", SYS_${n});`).join("")}return 0;}`;
    const dir = mkdtempSync(join(base, "c-"));
    writeFileSync(join(dir, "n.c"), c);
    expect(spawnSync("gcc", [join(dir, "n.c"), "-o", join(dir, "n")]).status).toBe(0);
    const got = Object.fromEntries(spawnSync(join(dir, "n"), { encoding: "utf8" }).stdout.trim().split("\n").map((l) => l.split(" ") as [string, string]).map(([n, v]) => [n, Number(v)]));
    expect(got).toEqual(DENIED_CALLS.x64);
  });

  test.skipIf(!existsSync("/usr/include/asm-generic/unistd.h"))("the numbers are the ones of the generic table that aarch64 uses", () => {
    const header = readFileSync("/usr/include/asm-generic/unistd.h", "utf8");
    for (const [name, nr] of Object.entries(DENIED_CALLS.arm64)) expect(new RegExp(`#define __NR_${name}\\s+${nr}\\b`).test(header), name).toBe(true);
  });
});

describe("what is built for macOS and for bubblewrap, as text", () => {
  const plan = { writable: ["/work/app", "/tmp", "/private/var/folders/x"], hiddenDirs: ["/Users/a/.ssh"], hiddenFiles: ["/Users/a/.netrc"] };
  test("the profile denies writes, allows the plan's folders, and hides what the plan hides, last", () => {
    const text = seatbeltProfile(plan, { network: true });
    const lines = text.split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines).toContain("(deny file-write*)");
    expect(text).toContain('(subpath "/work/app")');
    expect(text).toContain('(subpath "/tmp") (subpath "/private/tmp")');
    expect(text).toContain('(subpath "/private/var/folders/x") (subpath "/var/folders/x")');
    expect(text).not.toContain("deny network");
    // Later rules win: the hidden places are denied after the writable ones are allowed.
    expect(text.lastIndexOf("(allow file-write*")).toBeLessThan(text.indexOf('(deny file-read* (subpath "/Users/a/.ssh") (literal "/Users/a/.netrc"))'));
    expect(text).toContain('(deny file-write* (subpath "/Users/a/.ssh") (literal "/Users/a/.netrc"))');
  });
  test("with the network off only this computer's own addresses stay open; quotes in a path cannot end a string", () => {
    const text = seatbeltProfile({ ...plan, writable: ['/work/"x" y\\z'] }, { network: false });
    expect(text).toContain("(deny network*)");
    expect(text).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(text).toContain('(subpath "/work/\\"x\\" y\\\\z")');
  });
  test("bubblewrap: read-only root, the plan bound writable, hidden folders closed, hidden files empty, the network shared unless it is off", () => {
    const args = bubblewrapArgs(plan, { network: true }, { cwd: "/work/app", filter: true, dieWithParent: true }).join(" ");
    expect(args.startsWith("--ro-bind / / --dev /dev --die-with-parent --cap-drop ALL")).toBe(true);
    expect(args).toContain("--bind /work/app /work/app");
    expect(args).toContain("--perms 000 --tmpfs /Users/a/.ssh");
    expect(args).toContain("--ro-bind /dev/null /Users/a/.netrc");
    expect(args).toContain("--seccomp 3");
    expect(args).not.toContain("--unshare-net");
    expect(bubblewrapArgs(plan, { network: false }, { cwd: "/", filter: false, dieWithParent: false }).join(" ")).toContain("--unshare-net");
    expect(bubblewrapArgs(plan, { network: true }, { cwd: "/", filter: false, dieWithParent: false }).join(" ")).not.toContain("--die-with-parent");
  });
});

describe("what a command may write and cannot see", () => {
  test("the project, temp and caches may be written; the secret stores of the home and the env files above the project are hidden", () => {
    const h = mkdtempSync(join(base, "plan-"));
    const p = join(h, "work", "app");
    mkdirSync(p, { recursive: true });
    mkdirSync(join(h, ".ssh")); mkdirSync(join(h, ".cache")); mkdirSync(join(h, ".config", "google-chrome"), { recursive: true });
    writeFileSync(join(h, ".netrc"), "x"); writeFileSync(join(h, "work", ".env"), "KEY=1"); writeFileSync(join(p, ".env"), "KEY=2"); writeFileSync(join(h, "work", ".env.example"), "KEY=");
    writeFileSync(join(h, "own.json"), "{}");
    const plan = planFor({ root: p, home: h, tmp: [], hide: [join(h, "own.json"), join(h, "missing.json")] });
    expect(plan.writable).toContain(realpath(p));
    expect(plan.writable).toContain(realpath(join(h, ".cache")));
    expect(plan.hiddenDirs.map(realpath).sort()).toEqual([join(h, ".config", "google-chrome"), join(h, ".ssh")].map(realpath).sort());
    expect(plan.hiddenFiles.map(realpath).sort()).toEqual([join(h, ".netrc"), join(h, "own.json"), join(h, "work", ".env")].map(realpath).sort());
  });

  test("a project that is a linked worktree may write the git data it points to", () => {
    const main = mkdtempSync(join(base, "wt-"));
    const gitdir = join(main, ".git", "worktrees", "w");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    const wt = join(main, "checkout");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    const plan = planFor({ root: wt, home: main, tmp: [] });
    expect(plan.writable.map(realpath).sort()).toEqual([realpath(wt), realpath(join(main, ".git"))].sort());
  });

  test("a failure is the sandbox's only when it says so about a place the sandbox governs", () => {
    const plan = { writable: [project], hiddenDirs: [join(home, ".ssh")], hiddenFiles: [] };
    expect(denialIn("touch: cannot touch '/etc/x': Read-only file system", plan, project)).toEqual({ path: "/etc/x", kind: "write" });
    expect(denialIn("bash: /usr/local/bin/tool: Read-only file system", plan, project)).toEqual({ path: "/usr/local/bin/tool", kind: "write" });
    expect(denialIn(`EROFS: read-only file system, open '${away}/a.txt'`, plan, project)).toEqual({ path: join(away, "a.txt"), kind: "write" });
    expect(denialIn(`ls: cannot open directory '${join(home, ".ssh")}': Permission denied`, plan, project)).toEqual({ path: join(home, ".ssh"), kind: "hidden" });
    // An ordinary refusal, a read-only message about the project itself, and an unrelated failure are not the sandbox.
    expect(denialIn("touch: cannot touch '/etc/x': Permission denied", plan, project)).toBeUndefined();
    expect(denialIn(`cp: cannot create '${project}/a': Read-only file system`, plan, project)).toBeUndefined();
    expect(denialIn("npm ERR! code ENOENT", plan, project)).toBeUndefined();
  });
});
const realpath = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

describe.skipIf(!works)("a confined command, for real (bubblewrap)", () => {
  test("it writes the project and temp, and nowhere else; the line says what was in force", () => {
    const tmpFile = join(tmpdir(), `navvied-sb-${process.pid}`);
    const r = confined(`echo a > in.txt && echo b > ${tmpFile} && touch ${away}/out.txt; echo $?; touch /etc/navvied-x; echo $?`);
    expect(readFileSync(join(project, "in.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(tmpFile, "utf8")).toBe("b\n");
    rmSync(tmpFile);
    expect(existsSync(join(away, "out.txt"))).toBe(false);
    expect(r.out).toContain("Read-only file system");
    expect(r.line).toMatch(/^\[sandbox: writes only in the project, temp and caches; (secret folders hidden; )?network on; risky system calls blocked\]$/);
  });

  test("the line is built from what was done: secret folders only when there are some, network off when it was cut", () => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE");
    expect(confined("true").line).toBe("[sandbox: writes only in the project, temp and caches; secret folders hidden; network on; risky system calls blocked]");
    expect(confined("true", { network: false }).line).toContain("network off");
  });

  test("the secret stores cannot be read: a folder says why, a file is empty; a project's own env file can", () => {
    writeFileSync(join(home, ".netrc"), "machine x password y");
    writeFileSync(join(project, ".env"), "OWN=1");
    const r = confined("cat ~/.ssh/id_ed25519; ls ~/.ssh; cat ~/.netrc | wc -c; cat .env", {}, { cwd: project });
    expect(r.out).not.toContain("PRIVATE");
    expect(r.out).toContain("Permission denied");
    expect(r.out).toContain("OWN=1");
    const d = sandbox().confine(["true"], { root: project, cwd: project });
    expect(d.confined && d.denial(r.out.replaceAll("~", home).replace(/cat: \S+\.ssh\/id_ed25519/, `cat: ${join(home, ".ssh", "id_ed25519")}`), project)).toMatchObject({ kind: "hidden" });
  });

  test("a file of the program itself that holds keys is hidden too", () => {
    const own = join(home, "config.json");
    writeFileSync(own, '{"key":"SECRETKEY"}');
    expect(confined(`cat ${own} | wc -c`, {}, { hide: [own] }).out.trim().split("\n")[0]).toBe("0");
    expect(confined(`cat ${own}`).out).toContain("SECRETKEY");
  });

  test("the network is on, and a server on this computer can be reached; with the network off it cannot", async () => {
    const server = createServer((s) => s.end("hi"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const probe = `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo reached || echo cut`;
    try {
      expect(confined(probe).out.trim()).toBe("reached");
      expect(confined(probe, { network: false }).out.trim()).toBe("cut");
    } finally { server.close(); }
  });

  test("the temporary folder is the real one: what a command leaves there is there for the next", () => {
    const name = join(tmpdir(), `navvied-sb-keep-${process.pid}`);
    confined(`echo kept > ${name}`);
    expect(confined(`cat ${name}`).out.trim()).toBe("kept");
    rmSync(name, { force: true });
  });

  test("a call the filter refuses is refused, and the same call outside is not", () => {
    const call = "import ctypes; l=ctypes.CDLL(None,use_errno=True); print(l.syscall(101,0,0,0,0), ctypes.get_errno())";
    const python = spawnSync("python3", ["-c", call], { encoding: "utf8" });
    if (python.status !== 0) return;
    expect(python.stdout.trim()).toBe("0 0");
    expect(confined(`python3 -c '${call}'`).out.trim()).toBe("-1 1");
  });

  const tag = (): string => `${process.pid}${Math.floor(Math.random() * 100000)}`;
  const alive = (t: string): boolean => spawnSync("pgrep", ["-f", `^sleep [34]${t}$`]).status === 0;
  /** Ends the sleeps this test started (found by their own unique tag), by pid: nothing is ever killed by a name or a pattern. */
  const endTagged = (t: string): void => { for (const pid of spawnSync("pgrep", ["-f", `^sleep [34]${t}$`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ } } };

  test("when the process group is killed everything it started is gone", async () => {
    const t = tag();
    const launch = sandbox().confine(["bash", "-c", `sleep 3${t} & sleep 4${t}; wait`], { root: project, cwd: project, detached: true });
    if (!launch.confined) throw new Error("not confined");
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: project, detached: true, stdio: "ignore" });
    await until(() => alive(t));
    killTree(child);
    await until(() => !alive(t));
  });

  const anyProcessOf = (t: string): boolean => spawnSync("pgrep", ["-f", `sleep 3${t}`]).status === 0;
  const GONE_WITHIN_MS = 20_000;

  async function standIn(how: "foreground" | "interactive" | "detached"): Promise<{ tag: string; kill(): Promise<void> }> {
    const t = tag();
    const parent = spawn("bun", [join(import.meta.dir, "sandbox-parent.ts"), project, t, how], { stdio: ["ignore", "pipe", "inherit"] });
    const ended = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    await new Promise<void>((resolve) => parent.stdout.once("data", () => resolve()));
    return { tag: t, kill: () => { parent.kill("SIGKILL"); return ended; } };
  }

  test("a job meant to outlive the program does", async () => {
    const job = await standIn("detached");
    try {
      await until(() => alive(job.tag), GONE_WITHIN_MS);
      await job.kill();
      expect(alive(job.tag)).toBe(true);
    } finally { await job.kill(); endTagged(job.tag); }
  }, 30_000);

  test("a command whose parent dies right after it started never outlives it, however early", async () => {
    const runs = await Promise.all(Array.from({ length: 15 }, async (_, i) => {
      const program = await standIn(i % 5 === 4 ? "interactive" : "foreground");
      await wait(i * 2);
      await program.kill();
      return program.tag;
    }));
    try {
      await until(() => !runs.some(anyProcessOf), GONE_WITHIN_MS);
    } finally { runs.forEach(endTagged); }
  }, 30_000);

  test("a command is not started unless it is released by the program that is still its parent", () => {
    const launch = sandbox().confine(["sh", "-c", "echo started"], { root: project, cwd: project });
    if (!launch.confined || !launch.guarded) throw new Error("not guarded");
    // Descriptor 5 is where the program answers the guard: a program that died has closed it, so nothing arrives.
    const started = (input: string) => { const r = spawnSync("sh", ["-c", 'exec "$@" 4>/dev/null 5<&0', "sh", ...launch.argv], { input, encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
    expect(started("")).toEqual({ code: 125, out: "" });
    expect(started("go\n")).toEqual({ code: 0, out: "started\n" });
  });

  test("the person's other programs can be seen and stopped, as without the sandbox", async () => {
    const t = tag();
    const other = spawn("sleep", [`4${t}`], { stdio: "ignore" });
    try {
      expect(confined(`kill ${other.pid}; echo done`).out.trim()).toBe("done");
      await until(() => other.exitCode !== null || other.signalCode !== null);
    } finally { other.kill(); }
  });

  test("it costs a few milliseconds to start", async () => {
    const sb = sandbox();
    const time = async (argv: () => { argv: string[]; guarded: boolean }): Promise<number> => {
      const t = performance.now();
      for (let i = 0; i < 20; i++) { const a = argv(); await run(a.argv, { cwd: project, signal: new AbortController().signal, timeoutMs: 20_000, guarded: a.guarded }); }
      return (performance.now() - t) / 20;
    };
    const plain = await time(() => ({ argv: ["true"], guarded: false }));
    const wrapped = await time(() => { const l = sb.confine(["true"], { root: project, cwd: project }); return l.confined ? l : { argv: ["true"], guarded: false }; });
    console.log(`start of a command: ${plain.toFixed(1)} ms plain, ${wrapped.toFixed(1)} ms confined`);
    expect(wrapped - plain).toBeLessThan(150);
  });
});

describe("a command that cannot be confined is run as it is, and the person is told once", () => {
  test("no sandbox here: one plain line the first time, and the command is untouched", () => {
    const sb = new Sandbox({ setting: setting(), ability: { how: "none", filter: false, why: "bwrap is not installed" } });
    expect(sb.confine(["true"], { root: project, cwd: project })).toEqual({ confined: false, line: "[no sandbox: bwrap is not installed; commands run as they are]" });
    expect(sb.confine(["true"], { root: project, cwd: project })).toEqual({ confined: false });
  });
  test("turned off: nothing is said and nothing is wrapped; a system with no sandbox says why", () => {
    expect(new Sandbox({ setting: setting({ on: false }) }).confine(["true"], { root: project, cwd: project })).toEqual({ confined: false });
    const windows = new Sandbox({ setting: setting(), platform: "aix" }).confine(["true"], { root: project, cwd: project });
    expect(windows).toEqual({ confined: false, line: "[no sandbox: this system has no sandbox navvied can use; commands run as they are]" });
  });
  test("a program that already runs inside a sandbox says so", () => {
    expect(new Sandbox({ setting: setting(), nested: true }).confine(["true"], { root: project, cwd: project })).toMatchObject({ confined: false, line: expect.stringContaining("already runs inside a sandbox") });
  });
});

const bash = defaultTools().find((t) => t.name === "Bash")!;
const bashOutput = defaultTools().find((t) => t.name === "BashOutput")!;
const killShell = defaultTools().find((t) => t.name === "KillShell")!;
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: project, signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), sandbox: sandbox(), ...extra });

describe.skipIf(!works)("the Bash tool through the sandbox", () => {
  test("a result ends with the line; a failure caused by the sandbox is reported", async () => {
    const seen: unknown[] = [];
    const out = await bash.run({ command: `echo hi; touch ${away}/nope` }, ctx({ report: (m) => seen.push(m) }));
    const lines = out.split("\n");
    expect(lines[0]).toBe("hi");
    expect(lines.at(-1)).toMatch(/^\[sandbox: writes only in the project/);
    expect(seen).toContainEqual(expect.objectContaining({ denied: { path: join(away, "nope"), kind: "write" } }));
  });

  test("cd and export last across commands, through the sandbox", async () => {
    mkdirSync(join(project, "sub"), { recursive: true });
    const c = ctx({ shell: {} });
    await bash.run({ command: "cd sub && export KEPT=yes" }, c);
    const out = await bash.run({ command: "pwd; echo $KEPT" }, c);
    expect(out).toContain(`${realpath(join(project, "sub"))}\nyes`);
  });

  test("a job in the background runs confined, can be read and stopped, and its children go with it", async () => {
    const c = ctx();
    const started = await bash.run({ command: `echo up; touch ${away}/job-nope; echo end-$$; sleep 30`, run_in_background: true }, c);
    expect(started).toContain("Started job1");
    expect(started.split("\n").at(-1)).toMatch(/^\[sandbox:/);
    const read = await bashOutput.run({ job_id: "job1", wait: 5, until: "end-" }, c);
    expect(read).toContain("up");
    expect(read).toContain("Read-only file system");
    await killShell.run({ job_id: "job1" }, c);
    await c.jobs.waitFor("job1", 10_000, new AbortController().signal);
    expect(c.jobs.list()[0]!.status).not.toBe("running");
  });

  test("a program you type to runs confined in its terminal", async () => {
    const c = ctx();
    const started = await bash.run({ command: "cat", interactive: true }, c);
    expect(started).toContain("a program you can type to");
    const typed = defaultTools().find((t) => t.name === "BashInput")!;
    await typed.run({ job_id: "job1", text: "ping" }, c);
    expect(await bashOutput.run({ job_id: "job1", wait: 5, until: "ping" }, c)).toContain("ping");
    await killShell.run({ job_id: "job1" }, c);
  });

  test("a command that goes on silent is handed on as a job, still confined", async () => {
    const out = await bash.run({ command: "echo first; sleep 30", timeout: 1 }, ctx());
    expect(out).toContain("still running as job1");
    expect(out.split("\n").at(-1)).toMatch(/^\[sandbox:/);
  });

  test("the sandbox off: the same command writes outside, and no line is added", async () => {
    const out = await bash.run({ command: `touch ${away}/free.txt && echo ok` }, ctx({ sandbox: sandbox({ on: false }) }));
    expect(out).toBe("ok");
    expect(existsSync(join(away, "free.txt"))).toBe(true);
  });

  test("a command that is allowed outside once runs unconfined", async () => {
    const out = await bash.run({ command: `touch ${away}/once.txt && echo ok` }, ctx({ unconfined: true }));
    expect(out).toBe("ok");
  });
});

describe("a program that is not on this computer's backend keeps its own isolation", () => {
  test("a command sent to a container or another computer is not wrapped", async () => {
    const wrapped: string[][] = [];
    const out = await bash.run({ command: "echo remote" }, ctx({ backend: { id: "docker", prepare: (_c, cwd) => { wrapped.push(["sh", "-c", "echo remote"]); return { argv: ["sh", "-c", "echo remote"], cwd }; } }, sandbox: new Sandbox({ setting: setting(), ability: { how: "bubblewrap", filter: false } }) }));
    expect(out).toBe("remote");
    expect(wrapped).toHaveLength(1);
  });
});

describe.skipIf(!works)("the engine asks to run one command outside the sandbox, by mode", () => {
  const call = (command: string) => (req: { messages: { role: string }[] }) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command } }] });
  const outputOf = (r: ReturnType<typeof rig>): string => (r.events.filter((e) => e.ev === "tool" && e.status !== "running").at(-1) as { output?: string }).output ?? "";
  const cards = (r: ReturnType<typeof rig>) => r.of("approval");

  test("Ask: the person is asked after the first run; yes runs it outside, and the model is told both", async () => {
    const file = join(away, "ask.txt");
    const r = rig(call(`echo hi > ${file}`));
    r.send(prompt("go", { mode: "ask" }));
    await until(() => cards(r).length === 1);
    r.send({ cmd: "approve", id: cards(r)[0]!.id, optionId: "allow" });
    await until(() => cards(r).length === 2);
    expect(cards(r)[1]!.title).toContain("Run outside the sandbox");
    expect(cards(r)[1]!.risk).toContain(`tried to write ${file}`);
    expect(cards(r)[1]!.options.map((o) => o.optionId)).toEqual(["allow", "allow_always", "deny"]);
    expect(existsSync(file)).toBe(false);
    r.send({ cmd: "approve", id: cards(r)[1]!.id, optionId: "allow" });
    await r.engine.idle();
    expect(readFileSync(file, "utf8")).toBe("hi\n");
    expect(outputOf(r)).toContain(`[ran outside the sandbox: the command was stopped by the sandbox: it tried to write ${file}; the person allowed it]`);
    r.cleanup();
  });

  test("a no is told to the model plainly, and nothing was written", async () => {
    const file = join(away, "no.txt");
    const r = rig(call(`echo hi > ${file}`));
    r.send(prompt("go", { mode: "edits" }));
    await until(() => cards(r).length === 1);
    r.send({ cmd: "approve", id: cards(r)[0]!.id, optionId: "allow" });
    await until(() => cards(r).length === 2);
    r.send({ cmd: "approve", id: cards(r)[1]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(existsSync(file)).toBe(false);
    expect(outputOf(r)).toContain("The person was asked to run it outside the sandbox and said no");
    r.cleanup();
  });

  test("a refusal by a host that asked nobody says that nobody could be asked", async () => {
    const file = join(away, "unasked.txt");
    const r = rig(call(`echo hi > ${file}`));
    r.send(prompt("go", { mode: "edits" }));
    await until(() => cards(r).length === 1);
    r.send({ cmd: "approve", id: cards(r)[0]!.id, optionId: "allow" });
    await until(() => cards(r).length === 2);
    r.send({ cmd: "approve", id: cards(r)[1]!.id, optionId: "deny", unasked: true });
    await r.engine.idle();
    expect(existsSync(file)).toBe(false);
    expect(outputOf(r)).toContain("Nobody could be asked to run it outside the sandbox, so it was refused");
    expect(outputOf(r)).not.toContain("said no");
    r.cleanup();
  });

  test("allow always covers that folder: the next command there is not asked about again", async () => {
    const r = rig((req, n) => (req.messages[req.messages.length - 1]?.role === "tool" && n >= 2 ? { text: "done" } : { calls: [{ name: "Bash", args: { command: `echo ${n} > ${away}/always${n}.txt` } }] }));
    r.send(prompt("go", { mode: "auto" }));
    await until(() => cards(r).length === 1);
    r.send({ cmd: "approve", id: cards(r)[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    expect(cards(r)).toHaveLength(1);
    expect(existsSync(join(away, "always0.txt")) && existsSync(join(away, "always1.txt"))).toBe(true);
    r.cleanup();
  });

  test("Auto asks only because the place is outside the project; Bypass does not ask at all", async () => {
    const auto = rig(call(`echo a > ${away}/auto.txt`));
    auto.send(prompt("go", { mode: "auto" }));
    await until(() => cards(auto).length === 1);
    expect(cards(auto)[0]!.title).toContain("Run outside the sandbox");
    auto.send({ cmd: "approve", id: cards(auto)[0]!.id, optionId: "deny" });
    await auto.engine.idle();
    auto.cleanup();
    const bypass = rig(call(`echo b > ${away}/bypass.txt`));
    bypass.send(prompt("go", { mode: "bypass" }));
    await bypass.engine.idle();
    expect(cards(bypass)).toHaveLength(0);
    expect(readFileSync(join(away, "bypass.txt"), "utf8")).toBe("b\n");
    expect(outputOf(bypass)).toContain("Bypass mode lets it");
    bypass.cleanup();
  });

  test("a helper that cannot ask is told that nobody could be asked; the sandbox off means no question at all", async () => {
    const quiet = rig(call(`echo a > ${away}/quiet.txt`), { noQuestions: true });
    quiet.send(prompt("go", { mode: "auto" }));
    await quiet.engine.idle();
    expect(existsSync(join(away, "quiet.txt"))).toBe(false);
    expect(outputOf(quiet)).toContain("Nobody can be asked here");
    quiet.cleanup();
    const off = rig(call(`echo a > ${away}/off.txt`), { confinement: { setting: () => ({ on: false }) } });
    off.send(prompt("go", { mode: "auto" }));
    await off.engine.idle();
    expect(cards(off)).toHaveLength(0);
    expect(outputOf(off)).not.toContain("[sandbox");
    off.cleanup();
  });

  test("the hard floor holds: a command that may never run is not run outside either", async () => {
    const r = rig(call("rm -rf /"));
    r.send(prompt("go", { mode: "bypass" }));
    await r.engine.idle();
    expect(outputOf(r)).toContain("navvied never does this");
    r.cleanup();
  });
});
