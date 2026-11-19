import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, killTree, shellFor, usesProcessGroups } from "../src/index.ts";
import { inTerminal, launch } from "../src/platform.ts";
import { stopAllJobs } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

/** No file exists: a Windows computer is described only by what a test gives it, never by the one the tests run on. */
const none = (): boolean => false;
const has = (...names: string[]) => (cmd: string): string | null => (names.includes(cmd) ? `/found/${cmd}` : null);

describe("shellFor", () => {
  test("unix: bash when present, else sh", () => {
    expect(shellFor("linux", has("bash"))).toMatchObject({ name: "bash" });
    expect(shellFor("darwin", has("bash")).argv("echo hi")).toEqual(["bash", "-c", "echo hi"]);
    expect(shellFor("linux", has())).toMatchObject({ name: "sh" });
    expect(shellFor("linux", has()).argv("ls")).toEqual(["sh", "-c", "ls"]);
  });
  test("windows: Git Bash if installed, else PowerShell (pwsh first), else cmd", () => {
    expect(shellFor("win32", has("bash", "pwsh"), {}, none).name).toBe("bash");
    const exit = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
    expect(shellFor("win32", has("pwsh", "powershell"), {}, none).argv("dir")).toEqual(["/found/pwsh", "-NoProfile", "-NonInteractive", "-Command", `dir${exit}`]);
    expect(shellFor("win32", has("powershell"), {}, none).argv('"C:\\Program Files\\bun.exe" "C:\\x.js"')[4]).toBe(`& "C:\\Program Files\\bun.exe" "C:\\x.js"${exit}`);
    expect(shellFor("win32", has("powershell"), {}, none).argv("  'a b.exe' x")[4]).toBe(`&   'a b.exe' x${exit}`);
    expect(shellFor("win32", has("powershell"), {}, none).name).toBe("PowerShell");
    expect(shellFor("win32", has(), {}, none)).toMatchObject({ name: "cmd" });
    expect(shellFor("win32", has(), {}, none).argv("dir")).toEqual(["cmd.exe", "/d", "/s", "/c", "dir"]);
  });
  test("windows: the bash that is a door into WSL is never used; Git's own bash is found beside git or where Git installs", () => {
    const where = (found: Record<string, string>) => (cmd: string): string | null => found[cmd] ?? null;
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const git = "C:\\Program Files\\Git\\bin\\bash.exe";
    const exists = (...paths: string[]) => (p: string): boolean => paths.includes(p);
    expect(shellFor("win32", where({ bash: wsl }), {}, exists()).name).toBe("cmd");
    expect(shellFor("win32", where({ bash: wsl, powershell: "C:\\ps.exe" }), {}, exists()).name).toBe("PowerShell");
    expect(shellFor("win32", where({ bash: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe" }), {}, exists()).name).toBe("cmd");
    expect(shellFor("win32", where({ bash: wsl, git: "C:\\Program Files\\Git\\cmd\\git.exe" }), {}, exists(git)).argv("ls")).toEqual([git, "-c", "ls"]);
    expect(shellFor("win32", where({ bash: wsl }), { ProgramFiles: "C:\\Program Files" }, exists(git)).argv("ls")[0]).toBe(git);
    expect(shellFor("win32", where({ bash: wsl }), { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, exists("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe")).name).toBe("bash");
    expect(shellFor("win32", where({ bash: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" }), {}, exists()).argv("ls")[0]).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
  });
  test("this machine has a working shell", () => {
    const shell = shellFor();
    const r = Bun.spawnSync(shell.argv("echo ok"), { stdout: "pipe" });
    expect(r.stdout.toString()).toContain("ok");
  });
});

describe("process trees", () => {
  test("process groups are used everywhere but Windows", () => {
    expect(usesProcessGroups("linux")).toBe(true);
    expect(usesProcessGroups("darwin")).toBe(true);
    expect(usesProcessGroups("win32")).toBe(false);
  });
  test.skipIf(process.platform === "win32")("killTree stops a process and the children it started", async () => {
    const child = spawn("sh", ["-c", "sleep 30 & sleep 30; echo never"], { detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    killTree(child);
    await exited;
    expect(Date.now() - t0).toBeLessThan(2000);
    // The children are told to stop at the same moment; on a busy machine the system may take a moment to remove them.
    let left = "";
    for (let i = 0; i < 40; i++) {
      left = Bun.spawnSync(["pgrep", "-g", String(child.pid)], { stdout: "pipe" }).stdout.toString().trim();
      if (!left) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(left).toBe("");
  });
});

describe("a terminal for a program you type to", () => {
  test("the script program of each system, and none on Windows or without it", () => {
    expect(inTerminal(["python3", "-q"], "linux", has("script"))).toEqual(["script", "-qefc", "'python3' '-q'", "/dev/null"]);
    const mac = inTerminal(["python3", "-q"], "darwin", has("script"))!;
    expect(mac.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(mac.slice(3)).toEqual(["sh", "python3", "-q"]);
    expect(inTerminal(["python3"], "win32", has("script"))).toBeUndefined();
    expect(inTerminal(["python3"], "darwin", has())).toBeUndefined();
  });

  // The macOS script program refuses a socket as its input; this stand-in does the same, then runs the Linux one, so the macOS command
  // is run for real here.
  const real = process.platform === "linux" ? Bun.which("script") : null;
  const dir = mkdtempSync(join(tmpdir(), "navvied-terminal-"));
  afterAll(hook("platform removes what it made", async () => { await stopAllJobs(); await removeTree(dir); }));
  writeFileSync(join(dir, "script"), [
    "#!/bin/sh",
    '[ -S /proc/self/fd/0 ] && { echo "script: tcgetattr: Operation not supported on socket" >&2; exit 1; }',
    '[ "$1" = -q ] && [ "$2" = /dev/null ] || exit 64',
    "shift 2",
    `cmd=""; for a in "$@"; do cmd="$cmd '$(printf %s "$a" | sed "s/'/'\\\\''/g")'"; done`,
    `exec ${JSON.stringify(real ?? "script")} -qefc "$cmd" /dev/null`,
    "",
  ].join("\n"));
  chmodSync(join(dir, "script"), 0o755);
  const env = { PATH: `${dir}:${process.env.PATH ?? ""}` };
  const mac = (command: string): string[] => inTerminal(["sh", "-c", command], "darwin", () => "script")!;

  const until = async (jobs: Jobs, id: string, done: (seen: string) => boolean): Promise<string> => {
    let seen = "";
    const stop = new AbortController().signal;
    for (let i = 0; i < 50 && !done(seen); i++) { await jobs.waitFor(id, 200, stop); seen += jobs.read(id)!.output; }
    return seen;
  };

  // What the job started outside the terminal (script and the copier in front of it), by their process group. The program runs in the
  // terminal's own session, so it prints the group of its parent, script.
  const leftAfter = async (output: string): Promise<string> => {
    const group = /group (\d+)/.exec(output)?.[1];
    expect(group).toBeDefined();
    let left = "";
    for (let i = 0; i < 40; i++) {
      left = Bun.spawnSync(["pgrep", "-g", group!], { stdout: "pipe" }).stdout.toString().trim();
      if (!left) break;
      await Bun.sleep(50);
    }
    return left;
  };
  const group = 'echo "group $(ps -o pgid= -p $PPID | tr -d " ")"';

  test.skipIf(!real)("on macOS the program gets its answers, and the job ends with its code, and nothing of it is left, when the program ends", async () => {
    const jobs = new Jobs(() => undefined);
    const job = jobs.start(mac(`${group}; read -p "name? " n; echo "hello $n"; exit 3`), dir, "ask", env, true);
    let seen = await until(jobs, job.id, (s) => s.includes("name?"));
    expect(seen).toContain("name?");
    expect(jobs.type(job.id, "world\n")).toBe(true);
    seen += await until(jobs, job.id, (s) => s.includes("hello world"));
    expect(seen).toContain("hello world");
    await until(jobs, job.id, () => jobs.list()[0]!.status !== "running");
    expect(jobs.list()[0]).toMatchObject({ status: "failed", code: 3 });
    expect(await leftAfter(seen)).toBe("");
    jobs.close();
  });

  test.skipIf(!real)("on macOS the end of the input reaches the program, and the copier in front of the terminal ends with it", async () => {
    const jobs = new Jobs(() => undefined);
    const job = jobs.start(mac(`${group}; cat >/dev/null; echo after`), dir, "eof", env, true);
    let seen = await until(jobs, job.id, (s) => s.includes("group"));
    expect(jobs.endInput(job.id)).toBe(true);
    seen += await until(jobs, job.id, (s) => s.includes("after"));
    expect(seen).toContain("after");
    await until(jobs, job.id, () => jobs.list()[0]!.status !== "running");
    expect(jobs.list()[0]).toMatchObject({ status: "done", code: 0 });
    expect(await leftAfter(seen)).toBe("");
    jobs.close();
  });
});

describe("starting a program", () => {
  const where = (found: Record<string, string>) => (cmd: string): string | null => found[cmd] ?? null;
  test("outside Windows the arguments are left as they are", () => {
    expect(launch(["npx", "-y", "pkg"], "linux", where({ npx: "/usr/bin/npx" }))).toEqual(["npx", "-y", "pkg"]);
  });
  test("on Windows a real program is started by the path it was found at", () => {
    expect(launch(["agent", "-p", 'say "hi"'], "win32", where({ agent: "C:\\bin\\agent.exe" }))).toEqual(["C:\\bin\\agent.exe", "-p", 'say "hi"']);
    expect(launch(["nothing", "x"], "win32", where({}))).toEqual(["nothing", "x"]);
  });
  test("on Windows a .cmd program (npx, and programs from npm) goes through cmd.exe, each word quoted", () => {
    expect(launch(["npx", "-y", "@scope/pkg", "C:\\my dir"], "win32", where({ npx: "C:\\Program Files\\nodejs\\npx.cmd" })))
      .toEqual(["cmd.exe", "/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npx.cmd" "-y" "@scope/pkg" "C:\\my dir""']);
  });
  test("what cmd would read as its own is refused with a sentence, not passed on", () => {
    const cmd = where({ tool: "C:\\n\\tool.cmd" });
    for (const bad of ['--settings={"a":1}', "%PATH%", "line\nbreak"]) expect(() => launch(["tool", bad], "win32", cmd)).toThrow(/batch file/);
    expect(() => launch(["tool", "a&b|c>d^e"], "win32", cmd)).not.toThrow();
  });
});
