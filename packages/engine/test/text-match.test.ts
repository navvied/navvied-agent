import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_FILE, alike, closest, distance, fold, fuse, memoryText, terms, wordsOf } from "../src/index.ts";
import { Jobs, defaultTools } from "../src/index.ts";
import type { Recall, ToolContext } from "../src/types.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { HOOK_MS, hook, removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
afterAll(hook("text-match removes what it made", async () => { await removeTrees(dirs); await cleanupAll(); }), HOOK_MS);

describe("looser matching of words", () => {
  test("accents and capitals fold on Latin and Greek letters, and other scripts keep their marks", () => {
    expect(fold("Café ÉCOLE Ångström")).toBe("cafe ecole angstrom");
    expect(fold("Straße")).toBe("straße");
    expect(fold("हिंदी")).toBe("हिंदी");
    expect(wordsOf("Naïve façade, 2026!")).toEqual(["naive", "facade", "2026"]);
  });
  test("Chinese and Japanese become pairs of neighbouring characters; a single character stays", () => {
    expect(terms("数据库迁移")).toEqual(["数据", "据库", "库迁", "迁移"]);
    expect(terms("テスト run 本")).toEqual(["テス", "スト", "run", "本"]);
  });
  test("a slip is a letter added, dropped, changed or two swapped; a short word allows none", () => {
    expect(distance("deploy", "deploys", 1)).toBe(1);
    expect(distance("deploy", "delpoy", 1)).toBe(1);
    expect(distance("deploy", "depl", 1)).toBe(2);
    expect(alike("deploy", "deploys")).toBe(true);
    expect(alike("formating", "formatting")).toBe(true);
    expect(alike("tabs", "tabx")).toBe(false);
    expect(alike("test", "tests")).toBe(true);
    expect(closest("recipx", ["recipe", "receipt"])).toBe("recipe");
    expect(closest("tabx", ["tabs"])).toBeUndefined();
  });
  test("lists are fused by place: a thing high in one list and in the other comes before one that is only in the middle of both", () => {
    const score = fuse([["a", "b", "c"], ["c", "b"]]);
    expect([...score].sort((x, y) => y[1] - x[1]).map(([k]) => k)).toEqual(["c", "b", "a"]);
  });
});

describe("notes found by looser matching", () => {
  function paths(notes: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "navvied-match-")); dirs.push(dir);
    mkdirSync(join(dir, "p"), { recursive: true });
    const project = join(dir, "p", MEMORY_FILE);
    writeFileSync(project, notes.map((t, i) => `- 2026-01-${String(i + 1).padStart(2, "0")}: ${t}`).join("\n"));
    return { user: join(dir, "u.md"), project };
  }
  const filler = ["Lunch is at noon", "Parking is behind the shed", "The cat is called Miso", "Coffee is on the second floor", "Fridays are quiet", "Badges are blue"];
  test("a typo, a plural and an accent still find the note; Chinese is found by its characters", () => {
    expect(memoryText(paths(["Run the migrations before every deploy", ...filler]), "how do i deplyo")).toContain("migrations");
    expect(memoryText(paths(["The café menu is in the wiki", ...filler]), "where is the cafe menu")).toContain("café");
    expect(memoryText(paths(["数据库迁移在周五执行", ...filler]), "数据库什么时候迁移")).toContain("数据库迁移");
    expect(memoryText(paths(["Run the migrations before every deploy", ...filler]), "something unrelated entirely")).not.toContain("migrations");
  });
});

describe("the Recall tool and the notice", () => {
  const recallTool = defaultTools().find((t) => t.name === "Recall")!;
  const ctx = (recall: Recall): ToolContext => ({ cwd: ".", signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined), recall });
  const hit = { id: "a1", title: "Dates", snippet: "ISO 8601", updated: Date.UTC(2026, 0, 2), n: 2 };
  test("a search may be answered later, and the one plain line of the notice follows the results or the empty answer", async () => {
    const note = "Search by meaning is off right now (the embeddings server did not answer in time); these results are by words.";
    const later: Recall = { search: async () => [hit], read: () => undefined, recent: () => [], notice: () => note };
    expect(await recallTool.run({ query: "dates" }, ctx(later))).toBe(`- Dates (id a1, 2026-01-02, message 2): ISO 8601\n${note}`);
    const none: Recall = { ...later, search: async () => [] };
    expect(await recallTool.run({ query: "dates" }, ctx(none))).toBe(`No earlier conversation mentions "dates". Try other words, or fewer.\n${note}`);
    const quiet: Recall = { ...later, notice: () => undefined };
    expect(await recallTool.run({ query: "dates" }, ctx(quiet))).toBe("- Dates (id a1, 2026-01-02, message 2): ISO 8601");
  });
});

describe("the engine asks the host to prepare before the standing notes are read", () => {
  test("`prepare` is awaited with the person's last words before `instructions`, and a failure is ignored", async () => {
    const order: string[] = [];
    const r = rig(() => ({ text: "ok" }), {
      prepare: async ({ userText }) => { order.push(`prepare:${userText}`); await Promise.resolve(); throw new Error("down"); },
      instructions: (req) => { order.push(`instructions:${req?.userText}`); return undefined; },
    });
    await r.turn(prompt("how do we format dates"));
    expect(order.slice(0, 2)).toEqual(["prepare:how do we format dates", "instructions:how do we format dates"]);
    expect(r.text()).toContain("ok");
    r.cleanup();
  });
});
