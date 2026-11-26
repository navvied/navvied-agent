import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "../../engine/src/mcp.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { main } from "../src/ab.ts";
import type { AbRun } from "../src/ab-report.ts";
import { loadTasks, solutionScript, type Task } from "../src/task.ts";
import { check, FIXTURES, killProcesses, leftovers, agentConfig, prepare, scriptEnv, shell } from "../src/workspace.ts";
import { world } from "../fixtures/mc2-data.ts";
import { drive, solver, type Step } from "../fixtures/mc2-solve.ts";

const tasks = loadTasks(join(import.meta.dir, "../tasks")).filter((t) => t.id.startsWith("mc2-"));
const state = mkdtempSync(join(tmpdir(), "navvied-mc2-test-"));
afterAll(hook("the second-measurement tests remove what they made", async () => { await removeTree(state); }), HOOK_MS);

const SERVER = join(FIXTURES, "mcp-records.ts");
const PREFIX = "mcp__records__";

/** The call count each task is built to take for a model that does one call at a time, and the part of it that is data (no Write, no Read). */
const SHAPE: Record<string, { calls: [number, number]; kb: [number, number] }> = {
  "mc2-fan-out": { calls: [45, 45], kb: [110, 150] },
  "mc2-page-walk": { calls: [29, 40], kb: [70, 120] },
  "mc2-ticket-pipeline": { calls: [26, 26], kb: [55, 80] },
  "mc2-compare-pages": { calls: [14, 14], kb: [70, 90] },
  "mc2-pages-to-accounts": { calls: [26, 26], kb: [100, 140] },
  "mc2-first-account": { calls: [3, 3], kb: [0.3, 1.5] },
};

describe("the second-measurement tasks", () => {
  test("there are six, each declares the connected program, has a reference for both arms, and a short plain prompt that names no tool", () => {
    expect(tasks.map((t) => t.id).sort()).toEqual(Object.keys(SHAPE).sort());
    for (const t of tasks) {
      expect(t.mcp, t.id).toEqual({ records: { fixture: "mcp-records.ts" } });
      expect(solutionScript(t), t.id).toContain("from navvied_tools import *");
      expect(t.prompt.length, t.id).toBeLessThan(500);
      expect(t.prompt, t.id).not.toMatch(/\b(mcp|WebFetch|Bash|tool|script|python|curl)\b/i);
    }
  });

  test("a task without a connected program gets no configuration; one with it gets a private file that the run removes", () => {
    const plain = loadTasks(join(import.meta.dir, "../tasks"), ["mc-triage-logs"])[0]!;
    expect(agentConfig(plain).env).toEqual({});
    const config = agentConfig(tasks[0]!);
    const path = config.env.NAVVIED_CONFIG!;
    try {
      if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
      const file = JSON.parse(readFileSync(path, "utf8")) as { mcp: Record<string, { command: string; args: string[] }> };
      expect(file.mcp.records!.args).toEqual([SERVER]);
    } finally { config.remove(); }
    expect(existsSync(path)).toBe(false);
  });
});

describe("the connected program of the fixtures", () => {
  test("the agent's own client lists its four tools and pages through the accounts; a wrong call is an error, not a crash", async () => {
    const client = await McpClient.start("records", { command: process.execPath, args: [SERVER], env: { BENCH_SECRET: "one" } });
    try {
      expect((await client.tools()).map((t) => t.name)).toEqual(["list_accounts", "get_account", "get_invoices", "search_tickets"]);
      const signal = new AbortController().signal;
      const ids: string[] = [];
      let pages = 0;
      for (let page: number | null = 1; page; pages++) { const r = JSON.parse(await client.call("list_accounts", { page }, signal)) as { accounts: string[]; next_page: number | null }; expect(r.accounts.length).toBe(10); ids.push(...r.accounts); page = r.next_page; }
      expect(pages).toBe(4);
      expect(new Set(ids).size).toBe(40);
      const sizes = await Promise.all(ids.map(async (id) => ({ account: (await client.call("get_account", { id }, signal)).length, invoices: (await client.call("get_invoices", { account_id: id }, signal)).length })));
      for (const s of sizes) { expect(s.account).toBeGreaterThanOrEqual(2500); expect(s.account).toBeLessThanOrEqual(4000); expect(s.invoices).toBeGreaterThanOrEqual(1000); expect(s.invoices).toBeLessThanOrEqual(2800); }
      expect(await client.call("get_account", { id: "AC-0000" }, signal)).toBe("Error: no account AC-0000");
      expect(await client.call("list_accounts", { page: 5 }, signal)).toContain("there is no page 5");
      expect(await client.call("search_tickets", {}, signal)).toContain("query is needed");
    } finally { client.close(); }
  });

  test("the data comes from the secret: another secret gives other accounts", async () => {
    const first = async (secret: string): Promise<string> => { const c = await McpClient.start("records", { command: process.execPath, args: [SERVER], env: { BENCH_SECRET: secret } }); try { return await c.call("list_accounts", { page: 1 }, new AbortController().signal); } finally { c.close(); } };
    expect(await first("one")).toBe(await first("one"));
    expect(await first("one")).not.toBe(await first("two"));
  });
});

/** Does a task one call at a time through the real client and the real fixture web, as the plain arm does. */
async function stepwise(task: Task, secret: string): Promise<{ dir: string; calls: number; kb: number; data: number }> {
  const dir = prepare(task);
  const env = scriptEnv({ BENCH_SECRET: secret });
  const setup = task.setup ? await shell(dir, task.setup, env) : { ok: true, output: "" };
  expect(setup.ok, setup.output).toBe(true);
  const client = await McpClient.start("records", { command: process.execPath, args: [SERVER], env: { BENCH_SECRET: secret } });
  try {
    let data = 0;
    const done = await drive(solver(task.id)!, async (step: Step) => {
      if (step.tool.startsWith(PREFIX)) { data += 1; return client.call(step.tool.slice(PREFIX.length), step.args, new AbortController().signal); }
      if (step.tool === "Write") { writeFileSync(join(dir, String(step.args.file_path)), String(step.args.content)); return "ok"; }
      if (step.tool === "Read") return `     1\t${readFileSync(join(dir, String(step.args.file_path)), "utf8")}`;
      data += 1;
      return (await fetch(String(step.args.url))).text();
    });
    return { dir, calls: done.calls, kb: done.chars / 1000, data };
  } finally { client.close(); }
}

describe("each task can be done by a model that makes the calls one at a time", () => {
  test.each(tasks.map((t) => [t.id, t] as const))("%s: the calls and their results are the size the task is built for, the check passes, and it fails for another secret", async (_id, task) => {
    const mine = scriptEnv({ BENCH_SECRET: "secret-one" }), other = scriptEnv({ BENCH_SECRET: "secret-two" });
    const dir = prepare(task);
    try {
      if (task.setup) expect((await shell(dir, task.setup, mine)).ok).toBe(true);
      expect((await check(dir, task, 120_000, mine)).ok, "passes untouched").toBe(false);
    } finally { killProcesses(leftovers(dir)); if (task.teardown) await shell(dir, task.teardown, mine).catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }

    const run = await stepwise(task, "secret-one");
    try {
      const want = SHAPE[task.id]!;
      expect(run.calls).toBeGreaterThanOrEqual(want.calls[0]);
      expect(run.calls).toBeLessThanOrEqual(want.calls[1]);
      expect(run.kb).toBeGreaterThanOrEqual(want.kb[0]);
      expect(run.kb).toBeLessThanOrEqual(want.kb[1]);
      expect((await check(run.dir, task, 120_000, mine)).ok, "passes with its work").toBe(true);
      expect((await check(run.dir, task, 120_000, other)).ok, "fails for another secret").toBe(false);
    } finally { killProcesses(leftovers(run.dir)); if (task.teardown) await shell(run.dir, task.teardown, mine).catch(() => undefined); rmSync(run.dir, { recursive: true, force: true }); }
  }, 60_000);

  test("the page walk stops at the account on hold: the pages after it are not asked for", async () => {
    const task = tasks.find((t) => t.id === "mc2-page-walk")!;
    const asked: string[] = [];
    const client = await McpClient.start("records", { command: process.execPath, args: [SERVER], env: { BENCH_SECRET: "stop" } });
    try {
      await drive(solver(task.id)!, async (step) => { asked.push(`${step.tool}:${JSON.stringify(step.args)}`); return step.tool === "Write" ? "ok" : client.call(step.tool.slice(PREFIX.length), step.args, new AbortController().signal); });
    } finally { client.close(); }
    const lists = asked.filter((a) => a.includes("list_accounts")).length;
    const gets = asked.filter((a) => a.includes("get_account")).length;
    const at = world("stop").holdAt;
    expect(gets).toBe(at + 1);
    expect(lists).toBe(Math.ceil((at + 1) / 10));
    expect(gets).toBeLessThan(40);
  });
});

/** The connected programs of the fixture that this process started (or one of its children did): another test run on the same computer has its own, and they are not leftovers of this one. */
const connectedProgramsRunning = (): number[] => {
  if (process.platform !== "linux") return [];
  const parentOf = (pid: number): number => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); } catch { return 0; } };
  const mine = (pid: number): boolean => { for (let at = pid, hops = 0; at > 1 && hops < 40; at = parentOf(at), hops++) if (at === process.pid) return true; return false; };
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number).filter((n) => { try { return readFileSync(`/proc/${n}/cmdline`, "utf8").includes("mcp-records.ts") && mine(n); } catch { return false; } });
};

describe("the comparison runs them, in both arms, through the real program", () => {
  test("the scripted model solves a task of connected-program calls and one with web pages in both arms; the base arm makes the calls itself, the code arm from a script; nothing is left running", async () => {
    const out = join(state, "dry.jsonl");
    const was = connectedProgramsRunning();
    const quiet = async <T>(work: () => Promise<T>): Promise<T> => { const o = process.stdout.write, e = process.stderr.write; process.stdout.write = (() => true) as typeof process.stdout.write; process.stderr.write = (() => true) as typeof process.stderr.write; try { return await work(); } finally { process.stdout.write = o; process.stderr.write = e; } };
    expect(await quiet(() => main(["--dry", "--tasks", "mc2-pages-to-accounts,mc2-first-account", "--repeat", "1", "--out", out]))).toBe(0);
    const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AbRun);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r, `${r.task} ${r.arm}`).toMatchObject({ passed: true, reason: "solved" });
    const get = (task: string, arm: string): AbRun => rows.find((r) => r.task === task && r.arm === arm)!;
    expect(get("mc2-pages-to-accounts", "base").tools).toMatchObject({ [`${PREFIX}get_account`]: 12, WebFetch: 12 });
    expect(get("mc2-pages-to-accounts", "base").tools?.ExecuteCode).toBeUndefined();
    expect(get("mc2-pages-to-accounts", "code").tools?.ExecuteCode).toBe(1);
    expect(get("mc2-pages-to-accounts", "code").nestedCalls).toBe(25);
    expect(get("mc2-first-account", "base").toolCalls).toBe(3);
    expect(connectedProgramsRunning()).toEqual(was);
  }, 120_000);

  test("the runner takes the new tasks by name and keeps the first six as its default", async () => {
    const { plan } = await import("../src/ab.ts");
    expect((plan(["--dry", "--tasks", "mc2-fan-out"]) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual(["mc2-fan-out"]);
    expect((plan(["--dry"]) as { tasks: { id: string }[] }).tasks.every((t) => t.id.startsWith("mc-"))).toBe(true);
  });
});
