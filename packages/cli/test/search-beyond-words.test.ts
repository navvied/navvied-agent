import { describe, expect, test } from "bun:test";
import { SearchIndex } from "../src/search-index.ts";

const say = (k: "user" | "assistant", text: string) => ({ k, text });

function seeded(): SearchIndex {
  const db = new SearchIndex(":memory:");
  db.put("deploy", "Deploys", 10, [say("user", "the deployment failed again on staging"), say("assistant", "Restart the Café server and try the release once more")]);
  db.put("jp", "Tests", 20, [say("user", "日本語のテストを実行してください"), say("assistant", "テストは成功しました")]);
  db.put("zh", "Notes", 30, [say("user", "我们使用制表符缩进，数据库迁移在周五执行")]);
  db.put("other", "Cooking", 40, [say("user", "recipe for pancakes with maple syrup")]);
  return db;
}

describe("search beyond whole words", () => {
  test("a word inside another word is found by its letters", () => {
    expect(seeded().search("ploym")[0]).toMatchObject({ id: "deploy", n: 1 });
  });
  test("accents and capitals do not matter, in the query or in the text", () => {
    const db = seeded();
    expect(db.search("cafe")[0]).toMatchObject({ id: "deploy", n: 2 });
    expect(db.search("CAFÉ SERVER")[0]).toMatchObject({ id: "deploy", n: 2 });
  });
  test("a word with a slip is taken for the word of the text, in a longer query too", () => {
    const db = seeded();
    expect(db.search("deploymnt")[0]).toMatchObject({ id: "deploy" });
    expect(db.search("deplyoment failed")[0]).toMatchObject({ id: "deploy", n: 1 });
    expect(db.search("pancaeks syrup")[0]).toMatchObject({ id: "other" });
    expect(db.search("deploymnt staging", 5, true)[0]).toMatchObject({ id: "deploy" });
  });
  test("a short word is not changed into another one, and nothing near gives nothing", () => {
    const db = seeded();
    expect(db.search("recipx")[0]).toMatchObject({ id: "other" });
    expect(db.search("tabx")).toEqual([]);
    expect(db.search("zebra crossing")).toEqual([]);
  });
  test("Chinese and Japanese are found in the middle of a run of characters, with the passage shown", () => {
    const db = seeded();
    expect(db.search("テスト")[0]).toMatchObject({ id: "jp" });
    expect(db.search("数据库")[0]).toMatchObject({ id: "zh", n: 1 });
    expect(db.search("数据库")[0]!.snippet).toContain("[数据库]");
    expect(db.search("制表符")[0]).toMatchObject({ id: "zh" });
    expect(db.search("实行")).toEqual([]);
  });
  test("a one or two character query of Chinese or Japanese is found too", () => {
    const db = seeded();
    expect(db.search("周五")[0]).toMatchObject({ id: "zh" });
    expect(db.search("成")[0]).toMatchObject({ id: "jp", n: 2 });
  });
  test("whole words still come first, and an index of an older shape is rebuilt", () => {
    const db = seeded();
    expect(db.search("deployment failed")[0]).toMatchObject({ id: "deploy", n: 1 });
    expect(db.put("deploy", "Deploys", 10, [say("user", "the deployment failed again on staging"), say("assistant", "Restart the Café server and try the release once more")])).toBe(0);
  });
});
