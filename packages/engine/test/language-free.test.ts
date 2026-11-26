import { afterAll, describe, expect, test } from "bun:test";
import { SMALL_WINDOW, defaultTools } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";
import { browserHere } from "../src/tools/browser.ts";

afterAll(cleanupAll, HOOK_MS);

/** The same goal as a neat sentence and as real people write: slang, typos, capitals, no punctuation, blends of languages, one word. Nothing the engine offers may change between them. */
const GOALS: Record<string, string[]> = {
  "search the web": ["Please search the web for the latest news about Bun.", "cariin dong berita terbaru soal bun", "SEARCH GOOGLE NEWS BUN!!!", "serch internet bun nws plz", "berita bun?"],
  "open a page": ["Open https://example.com in the browser and click login.", "bukain situs example.com trus klik login", "OPEN EXAMPLE.COM", "buka web nya", "brwser example"],
  "schedule a job": ["Run the tests every night at 2am.", "jalanin test tiap malem jam 2 ya", "REMIND ME TOMORROW", "ingetin bsok pagi", "cron"],
  "use a helper": ["Use an agent to review the module in parallel.", "suruh agen cek modul itu barengan", "AGENT AGENT", "minta tolong helper", "bantu dong"],
  "remember and recall": ["Remember that I prefer tabs, and what did we decide last time?", "inget ya aku suka tab, kemaren kita putusin apa?", "REMEMBER THIS", "ingt ini", "kmrn gmn"],
  "a notebook and media": ["Fix the plot in analysis.ipynb and transcribe voice.mp3.", "benerin plot di analysis.ipynb sama transkrip voice.mp3", "LOOK AT THE SCREENSHOT", "liat gambar nya", "gambarin kucing"],
  "many files": ["For each of the 40 files in src/*.ts add a header.", "tambahin header ke 40 file src/*.ts", "ALL 40 FILES src/*.ts", "40 file src/*.ts header", "semua file"],
  "a skill": ["Turn this into a skill.", "bikin skill dari ini dong", "MAKE SKILL", "skil baru", "jadiin skill"],
  "nothing in particular": ["fix the failing test", "benerin tes yg gagal", "FIX IT", "tes gagal", "?"],
};

const variants = Object.entries(GOALS).flatMap(([goal, texts]) => texts.map((text) => [goal, text] as const));

const first = async (text: string, opts: Parameters<typeof rig>[1], dirOf: (d: string) => string = (d) => d): Promise<{ tools: string; system: string }> => {
  const r = rig(() => ({ text: "ok" }), opts);
  await r.turn(prompt(text));
  const q = r.provider.requests[0]!;
  const out = { tools: JSON.stringify(q.tools), system: q.system.split(dirOf(r.dir)).join("<dir>") };
  r.cleanup();
  return out;
};

describe("no tool and no prompt line depends on how a request is worded", () => {
  const reference = { reference: "How navvied works, in case the user asks: x" };
  for (const [label, opts] of [["a model with room", { ...reference }], ["a small model", { window: SMALL_WINDOW, small: true, ...reference }], ["a chat", { kind: "chat" as const }]] as const) {
    test(`${label}: every wording of every goal gets the byte-identical tools array and system prompt`, async () => {
      const base = await first("hello", opts);
      for (const [goal, text] of variants) {
        const got = await first(text, opts);
        expect(got.tools, `${goal}: ${text}`).toBe(base.tools);
        // The notes line names what the engine saved from this very message; it is a report of an action, not a choice of tools.
        expect(got.system.replace(/\n\nNotes being saved[^\n]*/, ""), `${goal}: ${text}`).toBe(base.system.replace(/\n\nNotes being saved[^\n]*/, ""));
      }
    }, 30_000);
  }

  test("the first request of a model that is not small lists every tool that is set up, by name; a small model's does not, and names them instead", async () => {
    const setup = { schedule: {} as never, skillBook: {} as never, memory: {} as never, recall: { recent: () => [{}] } as never };
    const all = ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "Bash", "Glob", "Grep", "WebFetch", "WebSearch", "Schedule", "SkillManage", "Remember", "Recall", "Agent", "TodoWrite", "AskUserQuestion"];
    for (const text of ["fix the failing test", "benerin tes yg gagal"]) {
      const big = rig(() => ({ text: "ok" }), setup);
      await big.turn(prompt(text));
      const listed = big.provider.requests[0]!.tools.map((t) => t.name);
      big.cleanup();
      expect(listed).toEqual(expect.arrayContaining(all));
      if (browserHere()) expect(listed).toContain("Browser");
      const small = rig(() => ({ text: "ok" }), { ...setup, window: SMALL_WINDOW, small: true });
      await small.turn(prompt(text));
      const q = small.provider.requests[0]!;
      small.cleanup();
      for (const heavy of ["NotebookEdit", "WebFetch", "WebSearch", "Browser", "Schedule", "SkillManage", "Remember", "Recall"]) expect(q.tools.map((t) => t.name)).not.toContain(heavy);
      expect(q.system).toMatch(/Also available, by name: .*Schedule/);
    }
  });

  test("the prompt carries the one line about choosing tools by the goal and asking one question, for a large and a small model", async () => {
    for (const opts of [{}, { window: SMALL_WINDOW, small: true }]) {
      const got = await first("fix it", opts);
      expect(got.system).toContain("Pick tools by the goal, not the words");
      expect(got.system).toContain("Ask one question (AskUserQuestion)");
    }
  });

  test("what the models were shown to act on, in plain words: asking when a value would be a guess, a list when one is asked for, earlier conversations for what was said before", async () => {
    const tools = (await first("hello", {})).tools;
    const describe = (name: string): string => (JSON.parse(tools) as { name: string; description: string }[]).find((t) => t.name === name)!.description;
    expect(describe("AskUserQuestion")).toContain("would be a guess");
    expect(describe("AskUserQuestion")).not.toContain("Decide small things yourself");
    expect(describe("TodoWrite")).toMatch(/to-do list|checklist/);
    expect(describe("TodoWrite")).toContain("It is not the result: do the steps");
    expect((await first("hello", {})).system).toContain("then do the steps");
    expect((await first("hello", {})).system).toContain("Clear request: do it, no offers. Must guess a value? Ask one question");
    expect((await first("hello", { window: SMALL_WINDOW, small: true })).system).toContain("Clear request: do it, no offers. Must guess a value? Ask one question");
    expect(defaultTools().find((t) => t.name === "Recall")!.description).toContain("what was said or decided before");
  });

  test("a chat has no question tool, so it is not told to use one", async () => {
    expect((await first("fix it", { kind: "chat" })).system).not.toContain("AskUserQuestion");
  });

  test("the program's own reference is in the prompt for every request, not only for one that asks about the program", async () => {
    for (const text of ["fix the failing test", "gimana cara undo?", "who are you"]) expect((await first(text, { ...reference })).system).toContain("How navvied works");
  });

  test("the small prompt and tools stay inside the budget with the line", async () => {
    const r = rig(() => ({ text: "ok" }), { window: SMALL_WINDOW, small: true });
    await r.turn(prompt("fix it"));
    const q = r.provider.requests[0]!;
    expect(q.system.length + JSON.stringify(q.tools).length).toBeLessThanOrEqual(3_100);
    r.cleanup();
  });
});
