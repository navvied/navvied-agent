import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsDir, commandLine, findBash, footprint, missingPrograms, misuseOf, instantiate, listAdapters, loadAdapter, parseAdapter, rate, sizeOf, summarize, wilson, type TaskResult } from "../src/index.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-bench-misc-"));
afterAll(hook("footprint removes what it made", async () => { await removeTree(dir); }));

describe("footprint", () => {
  test("a file and a folder are measured by what is in them", () => {
    mkdirSync(join(dir, "app/lib"), { recursive: true });
    writeFileSync(join(dir, "app/a"), "x".repeat(1000));
    writeFileSync(join(dir, "app/lib/b"), "y".repeat(234));
    expect(sizeOf(join(dir, "app/a"))).toBe(1000);
    expect(sizeOf(join(dir, "app"))).toBe(1234);
  });
  test("the first start is told apart from the rest, each with a home folder that is new, and the size is that of the install path", async () => {
    const homes = join(dir, "homes");
    const script = join(dir, "show-home.ts");
    writeFileSync(script, `import { appendFileSync, readdirSync } from "node:fs";\nappendFileSync(${JSON.stringify(homes)}, process.env.HOME + ":" + readdirSync(process.env.HOME!).length + "\\n");`);
    const f = await footprint([process.execPath, script], { install: join(dir, "app"), runs: 4 });
    expect(f.installBytes).toBe(1234);
    expect(f.runs).toBe(4);
    expect(f.firstMs).toBeGreaterThan(0);
    expect(f.medianMs).toBeGreaterThan(0);
    const lines = (await Bun.file(homes).text()).trim().split("\n");
    // The home folder and the number of entries in it, told apart at the last colon (a Windows path has one of its own).
    expect(new Set(lines.map((l) => l.slice(0, l.lastIndexOf(":")))).size).toBe(4);
    expect(lines.every((l) => l.endsWith(":0"))).toBe(true);
  });
  test("the runtime that runs source is not mistaken for the program", async () => {
    expect((await footprint([process.execPath, "-e", "0"], { runs: 2 })).installBytes).toBeUndefined();
  });
});

describe("rates", () => {
  test("the interval is wide for few runs and narrows with more, and holds the extremes", () => {
    expect(wilson(3, 4)).toEqual({ lo: 30, hi: 95 });
    expect(wilson(0, 5)).toEqual({ lo: 0, hi: 43 });
    expect(wilson(5, 5)).toEqual({ lo: 57, hi: 100 });
    expect(wilson(30, 40).hi - wilson(30, 40).lo).toBeLessThan(wilson(3, 4).hi - wilson(3, 4).lo);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 100 });
    expect(rate(3, 4)).toBe("3/4 (75%, 30 to 95%)");
  });
  const r = (task: string, model: string, passed: boolean, kind: TaskResult["kind"], level: TaskResult["level"], lang: TaskResult["lang"]): TaskResult => ({ task, model, passed, reason: passed ? "solved" : "check failed", ms: 1000, modelCalls: 2, toolCalls: 1, outTokens: 10, peakContext: 1, exitCode: 0, kind, level, lang });
  test("the report breaks the results down by kind, level and language, with the interval", () => {
    const text = summarize([r("a", "m1", true, "fix", 1, "ts"), r("b", "m1", false, "fix", 2, "py"), r("c", "m1", true, "terminal", 3, "sh"), r("a", "m2", true, "fix", 1, "ts")]);
    expect(text).toContain("| kind of work | m1 | m2 |");
    expect(text).toContain("| fix | 1/2 (50%, 9 to 91%) | 1/1 (100%, 21 to 100%) |");
    expect(text).toContain("| terminal | 1/1 (100%, 21 to 100%) | - |");
    expect(text).toContain("| level 2 | 0/1 (0%, 0 to 79%) | - |");
    expect(text).toContain("| py | 0/1 (0%, 0 to 79%) | - |");
  });
});

describe("agents described as data", () => {
  const good = { label: "example-agent", argv: ["example-agent", "--model", "{model}", "{prompt}"], env: { EXAMPLE_URL: "{base_url}", EXAMPLE_KEY: "{key}" }, version: ["example-agent", "--version"], install: "/usr/bin/example-agent" };
  test("a file is read, and filled in for one task", () => {
    const a = parseAdapter(good);
    expect(a).toMatchObject({ label: "example-agent", pointable: true, install: "/usr/bin/example-agent" });
    expect(instantiate(a, { prompt: "fix it", dir: "/w", model: "m1", baseUrl: "http://127.0.0.1:9/v1", key: "k" })).toEqual({ argv: ["example-agent", "--model", "m1", "fix it"], env: { EXAMPLE_URL: "http://127.0.0.1:9/v1", EXAMPLE_KEY: "k" } });
    expect(parseAdapter({ label: "plain", argv: ["x", "{prompt}"] }).pointable).toBe(false);
  });
  test("a file that is wrong is refused with the file's name and what is needed", () => {
    for (const [bad, said] of [[{ ...good, label: "bad name!" }, '"label"'], [{ ...good, argv: [] }, '"argv"'], [{ ...good, argv: ["x"] }, "{prompt}"], [{ ...good, env: { A: 1 } }, '"env"'], [{ ...good, version: "x" }, '"version"'], [null, '"label"']] as const) {
      expect(() => parseAdapter(bad, "mine.json"), said).toThrow(new RegExp(`mine\\.json: .*${said.replace(/[{}"]/g, (c) => `\\${c}`)}`));
    }
  });
  test("the folder is the person's own, outside the repository; files are found by label", () => {
    expect(agentsDir({ XDG_CONFIG_HOME: "/c" }, "linux")).toBe("/c/navvied/bench/agents");
    expect(agentsDir({ HOME: "/h" }, "linux")).toBe("/h/.config/navvied/bench/agents");
    expect(agentsDir({ APPDATA: "C:\\a" }, "win32")).toBe("C:\\a\\navvied\\bench\\agents");
    expect(agentsDir({ NAVVIED_BENCH_AGENTS: "/mine" }, "linux")).toBe("/mine");
    const folder = join(dir, "agents");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "b.json"), JSON.stringify({ label: "bee", argv: ["b", "{prompt}"] }));
    writeFileSync(join(folder, "a.json"), JSON.stringify(good));
    writeFileSync(join(folder, "notes.txt"), "ignored");
    expect(listAdapters(folder).map((x) => x.label)).toEqual(["example-agent", "bee"]);
    expect(loadAdapter(join(folder, "b.json")).label).toBe("bee");
    expect(listAdapters(join(dir, "nowhere"))).toEqual([]);
  });
});

describe("the shell that runs a task's commands", () => {
  const where = (found: Record<string, string>) => (c: string): string | null => found[c] ?? null;
  const none = (): boolean => false;
  test("bash is bash where there is one; on Windows Git's, never the launcher that Windows ships", () => {
    expect(findBash("linux", where({ bash: "/usr/bin/bash" }))).toBe("/usr/bin/bash");
    expect(findBash("linux", where({}))).toBeUndefined();
    expect(findBash("win32", where({ bash: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" }), {}, none)).toBe("C:\\Program Files\\Git\\usr\\bin\\bash.exe");
    expect(findBash("win32", where({ bash: "C:\\Windows\\System32\\bash.exe" }), {}, none)).toBeUndefined();
    expect(findBash("win32", where({ bash: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe" }), {}, none)).toBeUndefined();
    const git = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(findBash("win32", where({ bash: "C:\\Windows\\System32\\bash.exe", git: "C:\\Program Files\\Git\\cmd\\git.exe" }), {}, (p) => p === git)).toBe(git);
    expect(findBash("win32", where({}), { ProgramFiles: "C:\\Program Files" }, (p) => p === git)).toBe(git);
  });
  test("commands run in bash when there is one, else in the system's own shell", () => {
    expect(commandLine("echo hi", "/usr/bin/bash", "linux")).toEqual(["/usr/bin/bash", "-c", "echo hi"]);
    expect(commandLine("echo hi", null, "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "echo hi"]);
    expect(commandLine("echo hi", null, "linux")).toEqual(["sh", "-c", "echo hi"]);
  });
  test("a task that needs bash is skipped, not failed, where bash is missing", () => {
    const task = { requires: ["bash", "python3"] } as never;
    expect(missingPrograms(task, (p) => p === "python3")).toEqual(["bash"]);
    expect(missingPrograms(task, () => true)).toEqual([]);
  });
});

describe("misuse of the terminal", () => {
  const step = (name: string, input: Record<string, unknown>, output: string, status = "done") => ({ name, input, output, status });
  test("calls the tools refused, waits that only polled, and a cd where cwd would do are counted; honest use is not", () => {
    const m = misuseOf([
      step("Bash", { command: "cd app && npm test" }, "ok [exit 0]"),
      step("Bash", { command: "npm test", cwd: "app" }, "ok [exit 0]"),
      step("Bash", { command: "cd /tmp; ls" }, "x", "done"),
      step("BashOutput", { job_id: "job1" }, "(no new output)\n[job1: still running]"),
      step("BashOutput", { job_id: "job1" }, "(no new output)\n[job1: still running]"),
      step("BashOutput", { job_id: "job1", wait: 5 }, "(no new output)\n[job1: still running]"),
      step("BashOutput", { job_id: "job1", until: "ready" }, "(no new output)\n[job1: still running]"),
      step("BashOutput", { job_id: "job1" }, "ready\n[job1: still running]"),
      step("BashOutput", { job_id: "job9" }, 'Error: there is no job "job9".', "error"),
      step("KillShell", { job_id: "job1" }, "Error: there is no job", "error"),
      step("Bash", { command: "false" }, "[exit 1]", "done"),
      step("Read", { file_path: "a" }, "Error: nope", "error"),
    ]);
    expect(m).toEqual({ badCalls: 2, polls: 2, cdCalls: 2 });
  });
  test("a run with nothing to count says zero", () => {
    expect(misuseOf([])).toEqual({ badCalls: 0, polls: 0, cdCalls: 0 });
  });
});
