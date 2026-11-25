import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks } from "../src/task.ts";
import { missingPrograms, taskPrompt } from "../src/workspace.ts";

/** What the browser tasks promise: the person's message names the site, and the fixture shop behaves as the checks assume. */
const TASKS = join(import.meta.dir, "../tasks");
const IDS = ["browser-login", "browser-wrong-site", "browser-confirm", "browser-download", "browser-gate"];
const tasks = loadTasks(TASKS, IDS);
let out: string, base: string, server: Bun.Subprocess<"ignore", "pipe", "ignore">;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "navvied-browser-tasks-"));
  server = Bun.spawn([process.execPath, "web-server.ts"], { cwd: join(import.meta.dir, "../fixtures"), env: { ...process.env, BENCH_SECRET: "s", BENCH_OUT: out }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const said = new TextDecoder().decode((await server.stdout.getReader().read()).value);
  base = `http://127.0.0.1:${/ready (\d+)/.exec(said)![1]}`;
  writeFileSync(join(out, ".bench-port"), `${new URL(base).port}\n`);
});
afterAll(() => { server.kill(); rmSync(out, { recursive: true, force: true }); });

describe("the browser tasks", () => {
  test("there are five, they need a browser, and each names its site in the prompt by address, as a person does", () => {
    expect(tasks.map((t) => t.id).sort()).toEqual([...IDS].sort());
    for (const t of tasks) {
      expect(t.requires).toContain("browser");
      expect(taskPrompt(out, t)).toContain(`http://127.0.0.1:${new URL(base).port}/`);
      expect(t.prompt).not.toMatch(/\{port\}.*\{port\}.*\{port\}/);
    }
  });

  test("a computer with no browser skips them, and one with a browser does not", () => {
    expect(missingPrograms(tasks[0]!, (p) => p !== "browser")).toEqual(["browser"]);
    expect(missingPrograms(tasks[0]!, () => true)).toEqual([]);
  });

  test("the shop takes the right password only, says who sent it, and never writes the password down", async () => {
    const post = (host: string, password: string) => fetch(`${base.replace("127.0.0.1", host)}/login`, { method: "POST", body: new URLSearchParams({ email: "ann@example.com", password }), redirect: "manual" });
    const wrong = await post("127.0.0.1", "nope");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const right = await post("127.0.0.1", "Zx9!kQ7mPw");
    const cookie = right.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await fetch(`${base}/account`, { headers: { cookie } })).text()).toContain("Account code:");
    expect(await (await fetch(`${base}/account`)).text()).toContain("Please sign in");
    const log = readFileSync(join(out, "login.log"), "utf8");
    expect(log).toMatch(/127\.0\.0\.1:\d+ ann@example.com wrong\n127\.0\.0\.1:\d+ ann@example.com right/);
    expect(log).not.toContain("Zx9");
  });

  test("the entrance sends the browser to another address of the same computer, so it is another origin", async () => {
    const r = await fetch(`${base}/enter`, { redirect: "manual" });
    expect(r.headers.get("location")).toMatch(/^http:\/\/127\.0\.0\.2:\d+\/login$/);
  });

  test("the confirm page, the download and the gate say what the checks look for", async () => {
    expect(await (await fetch(`${base}/order`)).text()).toContain("confirm('Place the order?')");
    const csv = await fetch(`${base}/report.csv`);
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect(await csv.text()).toMatch(/month,code\njan,[0-9a-f]{10}\n/);
    expect(await (await fetch(`${base}/gate`)).text()).toContain("g-recaptcha");
  });
});
