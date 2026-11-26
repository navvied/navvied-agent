import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAbility } from "../src/index.ts";
import { ENDS_WITH_MARK, startWatcher } from "../src/sandbox/ends-with-us.ts";
import { HOOK_MS, hook, removeTree } from "../../protocol/test/support/cleanup.ts";
import { until } from "./helpers.ts";

const project = mkdtempSync(join(tmpdir(), "navvied-ends-with-us-"));
const tag = `${process.pid}${Math.floor(Math.random() * 100_000)}`;
const WITHIN_MS = 20_000;
const started: ChildProcess[] = [];

const sleeping = (): Map<string, number> => new Map(process.platform !== "linux" ? [] : spawnSync("pgrep", ["-af", `^sleep [0-9]+\\.${tag}$`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((line) => { const [pid, , seconds] = line.split(" "); return [seconds!.split(".")[0]!, Number(pid)]; }));
const asleep = (name: string): string => `sleep ${name}.${tag}`;

afterAll(hook("the watcher tests end what they started", async () => {
  for (const pid of sleeping().values()) { try { process.kill(pid, "SIGKILL"); } catch { continue; } }
  for (const child of started) child.kill("SIGKILL");
  await removeTree(project);
}), HOOK_MS);

function inItsOwnGroup(script: string, env: Record<string, string> = {}): void {
  started.push(spawn("sh", ["-c", script], { detached: true, stdio: "ignore", env: { ...process.env, ...env } }));
}

const processesCarrying = (entry: string): number[] => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((pid) => { try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry); } catch { return false; } }).map(Number);

describe.skipIf(process.platform !== "linux")("what is ended when the program is gone", () => {
  test("only what carries this program's mark and still sits in the group the mark names", async () => {
    const mine = `mine-${tag}`, another = `another-${tag}`;
    inItsOwnGroup(`${asleep("101")} & ${ENDS_WITH_MARK}="${mine}:$$"; export ${ENDS_WITH_MARK}; exec ${asleep("102")}`);
    inItsOwnGroup(`exec ${asleep("103")}`);
    inItsOwnGroup(`${ENDS_WITH_MARK}="${another}:$$"; export ${ENDS_WITH_MARK}; exec ${asleep("104")}`);
    inItsOwnGroup(`${ENDS_WITH_MARK}="${mine}:1$$"; export ${ENDS_WITH_MARK}; exec ${asleep("105")}`);
    inItsOwnGroup(`OTHER_${ENDS_WITH_MARK}="${mine}:$$"; export OTHER_${ENDS_WITH_MARK}; exec ${asleep("106")}`);
    inItsOwnGroup(`${ENDS_WITH_MARK}="x${mine}:$$"; export ${ENDS_WITH_MARK}; exec ${asleep("107")}`);
    await until(() => sleeping().size === 7, WITHIN_MS);
    const watcher = startWatcher(mine);
    const done = new Promise<void>((resolve) => watcher.once("exit", () => resolve()));
    watcher.stdin!.end();
    await done;
    await until(() => !sleeping().has("102"), WITHIN_MS);
    expect([...sleeping().keys()].sort()).toEqual(["101", "103", "104", "105", "106", "107"]);
  }, 40_000);

  test.skipIf(sandboxAbility().how !== "bubblewrap")("a program that ends as it should leaves no watcher and nothing else behind", async () => {
    const entry = `NAVVIED_TEST_PROGRAM=${tag}`;
    const program = spawn("bun", [join(import.meta.dir, "lookout-program.ts"), project, "engine"], { stdio: "ignore", env: { ...process.env, NAVVIED_TEST_PROGRAM: tag } });
    started.push(program);
    const code = await new Promise<number | null>((resolve) => program.once("exit", resolve));
    expect(code).toBe(0);
    await until(() => processesCarrying(entry).length === 0, WITHIN_MS);
  }, 60_000);
});
