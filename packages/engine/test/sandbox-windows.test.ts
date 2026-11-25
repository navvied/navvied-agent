import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SANDBOX, Sandbox, sandboxAbility, type SandboxSetting } from "../src/index.ts";
import { commandLine, quoteArg, useSandboxHelper, windowsLaunch, windowsLine } from "../src/sandbox/index.ts";
import { ACTIVE_PROCESSES, DENY_ONLY_GROUPS, UI_RESTRICTIONS, jobLimits, parseRun, startupInfo, uiLimits, wide } from "../src/sandbox/windows-run.ts";
import { windowsAbility } from "../src/sandbox/windows.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const base = mkdtempSync(join(tmpdir(), "navvied-sandbox-win-"));
afterAll(hook("sandbox-windows removes what it made", async () => { await removeTree(base); }), HOOK_MS);

const setting = (s: Partial<SandboxSetting> = {}) => () => ({ ...DEFAULT_SANDBOX, ...s });
const helper = ["navvied"];

describe("a command line as Windows reads it back (runs everywhere: pure text)", () => {
  test("arguments are quoted only when they must be, and backslashes only before a quote", () => {
    expect(quoteArg("plain")).toBe("plain");
    expect(quoteArg("")).toBe('""');
    expect(quoteArg("a b")).toBe('"a b"');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg("C:\\my dir\\")).toBe('"C:\\my dir\\\\"');
    expect(quoteArg('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteArg("C:\\path\\file.txt")).toBe("C:\\path\\file.txt");
  });

  test("an argument that is quoted reads back as it was (the rule, run as a parser)", () => {
    const parse = (line: string): string[] => {
      const out: string[] = [];
      let i = 0;
      while (i < line.length) {
        while (line[i] === " ") i++;
        if (i >= line.length) break;
        let arg = "", inQuote = false;
        for (; i < line.length && (inQuote || line[i] !== " "); i++) {
          let slashes = 0;
          while (line[i] === "\\") { slashes++; i++; }
          if (line[i] === '"') { arg += "\\".repeat(Math.floor(slashes / 2)); if (slashes % 2) arg += '"'; else inQuote = !inQuote; }
          else { arg += "\\".repeat(slashes); if (i < line.length) arg += line[i]; }
        }
        out.push(arg);
      }
      return out;
    };
    for (const argv of [["a", "b c", ""], ['x"y', "C:\\dir with space\\", "back\\\\slash\\"], ["he said \"a b\" \\"]]) expect(parse(commandLine(argv))).toEqual(argv);
  });

  test("the text after cmd /s /c goes to cmd as it is, because cmd reads it itself", () => {
    expect(commandLine(["cmd.exe", "/d", "/s", "/c", '""C:\\a b\\x.cmd" "arg"']).endsWith('/c ""C:\\a b\\x.cmd" "arg"')).toBe(true);
    expect(commandLine(["cmd.exe", "/d", "/c", "exit 0"])).toBe('cmd.exe /d /c "exit 0"');
    expect(commandLine(["C:\\Program Files\\Git\\bin\\bash.exe", "-c", "echo 'a b'"])).toBe(`"C:\\Program Files\\Git\\bin\\bash.exe" -c "echo 'a b'"`);
  });
});

describe("the helper's words and structures (runs everywhere: pure data)", () => {
  test("the command goes after --, a detached job says so", () => {
    expect(windowsLaunch(["navvied"], ["bash", "-c", "ls"], { detached: false })).toEqual(["navvied", "sandbox-run", "--", "bash", "-c", "ls"]);
    expect(windowsLaunch(["bun", "main.ts"], ["x"], { detached: true })).toEqual(["bun", "main.ts", "sandbox-run", "--detached", "--", "x"]);
    expect(parseRun(["--detached", "--", "a", "--", "b"])).toEqual({ detached: true, argv: ["a", "--", "b"] });
    expect(parseRun(["--"])).toBeUndefined();
    expect(parseRun(["a"])).toBeUndefined();
  });

  test("the job structure: kill on close only for a command that ends with its starter, a process limit always", () => {
    const v = (b: Uint8Array) => new DataView(b.buffer);
    const bound = jobLimits({ detached: false });
    expect(bound.length).toBe(144);
    expect(v(bound).getUint32(16, true)).toBe(0x2000 | 0x8);
    expect(v(bound).getUint32(40, true)).toBe(ACTIVE_PROCESSES);
    expect(v(jobLimits({ detached: true })).getUint32(16, true)).toBe(0x8);
    expect(v(uiLimits()).getUint32(0, true)).toBe(UI_RESTRICTIONS);
    expect(UI_RESTRICTIONS).toBe(0xff);
  });

  test("the start information is 104 bytes and carries the three handles at their places", () => {
    const b = startupInfo({ input: 1n, output: 2n, error: 3n });
    const v = new DataView(b.buffer);
    expect(b.length).toBe(104);
    expect(v.getUint32(0, true)).toBe(104);
    expect(v.getUint32(60, true)).toBe(0x100);
    expect([v.getBigUint64(80, true), v.getBigUint64(88, true), v.getBigUint64(96, true)]).toEqual([1n, 2n, 3n]);
  });

  test("text for the system is UTF-16 with a zero at the end; the groups that lose their power are the administrator ones", () => {
    expect([...wide("a€")]).toEqual([0x61, 0x20ac, 0]);
    expect([...DENY_ONLY_GROUPS]).toEqual([26, 29, 33]);
  });
});

describe("the sandbox on Windows, with a faked computer", () => {
  const win = (s: Partial<SandboxSetting> = {}, o: { helper?: string[] } = {}) => new Sandbox({ setting: setting(s), platform: "win32", ability: { how: "jobobject", filter: false }, helper: o.helper ?? helper, home: base });

  test("a command is started through the helper, and the line says what is in force and what is not", () => {
    const launch = win().confine(["bash", "-c", "ls"], { root: base, cwd: base });
    if (!launch.confined) throw new Error("not confined");
    expect(launch.argv).toEqual(["navvied", "sandbox-run", "--", "bash", "-c", "ls"]);
    expect(launch.line).toBe("[sandbox: administrator rights removed; its programs end with the command; writes and secret folders are not confined; network on]");
    expect(launch.denial("anything: Permission denied", base)).toBeUndefined();
  });

  test("a job that outlives the program says that, and the network switch is not claimed", () => {
    const launch = win({ network: false }).confine(["x"], { root: base, cwd: base, detached: true });
    if (!launch.confined) throw new Error("not confined");
    expect(launch.argv).toContain("--detached");
    expect(launch.line).toContain("a job keeps its own programs");
    expect(launch.line).toContain("network cannot be switched off here");
    expect(launch.line).not.toContain("network off");
    expect(windowsLine({ network: true }, { detached: false })).not.toContain("cannot be switched off");
  });

  test("turned off, nothing changes; with no helper, the command still runs, as it is, and the reason is said", () => {
    expect(win({ on: false }).confine(["x"], { root: base, cwd: base })).toEqual({ confined: false });
    const none = new Sandbox({ setting: setting(), platform: "win32", ability: { how: "jobobject", filter: false } });
    useSandboxHelper(undefined);
    const launch = none.confine(["x"], { root: base, cwd: base });
    expect(launch.confined).toBe(false);
    expect(launch.line).toContain("no sandbox");
  });

  test("the ability is what the helper did: success, its own reason on failure, or no helper at all", () => {
    const ran = (status: number, stderr = ""): typeof spawnSync => (() => ({ status, stderr })) as unknown as typeof spawnSync;
    expect(windowsAbility(helper, ran(0))).toEqual({ how: "jobobject", filter: false });
    expect(windowsAbility(helper, ran(1, "sandbox: restricting the token failed (error 87)\n"))).toEqual({ how: "none", filter: false, why: "restricting the token failed (error 87)" });
    expect(windowsAbility(helper, ran(1, "")).why).toBe("the Windows helper does not start");
    expect(windowsAbility(undefined).how).toBe("none");
  });
});

/** These run on a Windows computer only (public CI on Windows is where they are shown to pass). */
describe.skipIf(process.platform !== "win32")("the sandbox on a real Windows computer", () => {
  const main = join(import.meta.dir, "..", "..", "cli", "src", "main.ts");
  const words = [process.execPath, main];
  beforeAll(() => useSandboxHelper(words));
  afterAll(() => useSandboxHelper(undefined));
  const sandbox = new Sandbox({ setting: setting(), home: base, helper: words });
  const confined = (argv: string[], detached = false) => {
    const launch = sandbox.confine(argv, { root: base, cwd: base, detached });
    if (!launch.confined) throw new Error(`not confined: ${launch.line}`);
    return launch;
  };

  test("the computer can confine, and says how", () => {
    expect(sandboxAbility().how).toBe("jobobject");
  });

  test("a command runs, prints, and its exit code is the command's", () => {
    const launch = confined(["cmd.exe", "/d", "/c", "echo hello & exit 7"]);
    const r = spawnSync(launch.argv[0]!, launch.argv.slice(1), { encoding: "utf8", cwd: base });
    expect(r.stdout).toContain("hello");
    expect(r.status).toBe(7);
  });

  test("the command has lost its privileges", () => {
    const launch = confined(["whoami.exe", "/priv"]);
    const r = spawnSync(launch.argv[0]!, launch.argv.slice(1), { encoding: "utf8", cwd: base });
    expect(r.stdout).not.toContain("SeShutdownPrivilege");
    expect(r.stdout).not.toContain("SeDebugPrivilege");
  });

  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const wait = async (ok: () => boolean, ms = 15_000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 100)); } return ok(); };
  const sleeper = (file: string): string[] => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setTimeout(() => {}, 60000)`];

  test("the programs of a command end when the helper is ended", async () => {
    const file = join(base, "pid-bound");
    const launch = confined(sleeper(file));
    const helperProcess = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: base, stdio: "ignore", windowsHide: true });
    expect(await wait(() => existsSync(file))).toBe(true);
    const pid = Number(readFileSync(file, "utf8"));
    expect(alive(pid)).toBe(true);
    helperProcess.kill();
    expect(await wait(() => !alive(pid))).toBe(true);
  });

  test("the programs of a job that outlives the program stay when the helper is ended", async () => {
    const file = join(base, "pid-detached");
    const launch = confined(sleeper(file), true);
    const helperProcess = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: base, stdio: "ignore", windowsHide: true });
    expect(await wait(() => existsSync(file))).toBe(true);
    const pid = Number(readFileSync(file, "utf8"));
    helperProcess.kill();
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(pid)).toBe(true);
    process.kill(pid);
  });

  test("a command that runs a program with spaces and quotes in its arguments gets them as they were", () => {
    const out = join(base, "args.json");
    const script = join(base, "args.js");
    writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`);
    const given = ["a b", 'say "hi"', "C:\\dir with space\\", ""];
    const launch = confined([process.execPath, script, ...given]);
    spawnSync(launch.argv[0]!, launch.argv.slice(1), { cwd: base });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(given);
  });
});
