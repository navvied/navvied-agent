import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, skillTrustPath } from "../../cli/src/config.ts";
import { SkillTrust, projectSkillDirs } from "../../cli/src/plugins.ts";
import { TOOL_ROWS } from "../../cli/src/tool-table.ts";
import { loadSkills } from "../../engine/src/skills.ts";
import { installedMedia } from "../src/media-cache.ts";
import { agentConfig, check, mediaEnv, prepare, protectedChanged, shell, trustSkills } from "../src/workspace.ts";
import { main } from "../src/main.ts";
import { LANE_ROWS, caseFix, derive, judge, laneBases, laneJobs, laneTasks, mockTasks, tagged, wantedFiles, type LaneResult, type Tag } from "../src/newbie.ts";
import { CALLS, estimateLane, estimateTable, laneTable } from "../src/newbie-report.ts";
import { CANNOT_WORDS, LANE_TOOLS, NEWBIE, UNCHECKED_WORDS, type Style } from "../src/newbie-prompts.ts";
import { changesOf, type TaskResult } from "../src/run.ts";
import { validateTask } from "../src/validate.ts";

const result = (o: Partial<TaskResult>): TaskResult => ({ task: "t", model: "m", passed: true, reason: "solved", ms: 1, modelCalls: 1, toolCalls: 1, outTokens: 1, peakContext: 1, exitCode: 0, ...o });
const tag = (tool: string, lane: Tag["lane"] = "newbie"): Tag => ({ lane, tool, prompt: `${tool}-x`, styles: ["slang"] });

describe("the prompts", () => {
  test("every tool of the Tools list has at least five, and a lane to judge them by", () => {
    expect(LANE_ROWS.map((r) => r.id)).toEqual([...TOOL_ROWS.map((r) => r.id), "no-screen"]);
    for (const row of LANE_ROWS) {
      expect(LANE_TOOLS[row.id]?.accept.length).toBeGreaterThan(0);
      expect(NEWBIE.filter((p) => p.tool === row.id).length).toBeGreaterThanOrEqual(5);
    }
    expect(Object.keys(LANE_TOOLS).sort()).toEqual(LANE_ROWS.map((r) => r.id).sort());
  });

  test("the accepted tools are tools of the row (or, where nothing can be done, the ones that only look)", () => {
    for (const row of TOOL_ROWS) {
      const lane = LANE_TOOLS[row.id]!;
      if (row.id === "vision") expect(lane.accept).toEqual(["LookAt", "Read"]);
      else if (row.id === "video-generation") expect(lane.accept).toEqual(["MakeVideo", "Bash"]);
      else expect(lane.accept.every((t) => row.names.includes(t)), row.id).toBe(true);
    }
  });

  test("ids are unique, each is tied to a task that exists, and the words are the person's own, not the task's", () => {
    const tasks = new Map(laneTasks().map((t) => [t.id, t]));
    expect(new Set(NEWBIE.map((p) => p.id)).size).toBe(NEWBIE.length);
    for (const p of NEWBIE) {
      const task = tasks.get(p.task);
      expect(task, p.id).toBeDefined();
      expect(p.say.trim(), p.id).not.toBe(task!.prompt.trim());
      expect(p.styles.length, p.id).toBeGreaterThan(0);
    }
  });

  test("every way of asking is covered, and a follow-up has a first message to follow", () => {
    const all: Style[] = ["indonesian", "english", "blend", "slang", "typos", "no-punctuation", "caps", "vague", "wrong-assumption", "several-things", "follow-up", "pasted-error"];
    for (const s of all) expect(NEWBIE.some((p) => p.styles.includes(s)), s).toBe(true);
    for (const p of NEWBIE.filter((p) => p.styles.includes("follow-up"))) expect(p.then?.length, p.id).toBeGreaterThan(0);
    for (const p of NEWBIE.filter((p) => p.then)) expect(p.styles, p.id).toContain("follow-up");
  });

  test("the plain tasks they are tied to are fit to measure with (they fail untouched, pass with their solution)", async () => {
    for (const t of laneBases().filter((t) => t.id.startsWith("newbie-"))) expect(await validateTask(t), t.id).toEqual({ task: t.id, status: "ok", problems: [] });
  });

  test("the tasks made for the lane are small and have what the lane needs", () => {
    const own = laneTasks().filter((t) => t.id.startsWith("newbie-"));
    expect(own.map((t) => t.id).sort()).toEqual(["newbie-cannot-computer", "newbie-cannot-video", "newbie-notes-door", "newbie-recall", "newbie-watch-clip"]);
    expect(own.filter((t) => t.idle).map((t) => t.id).sort()).toEqual(["newbie-cannot-computer", "newbie-cannot-video"]);
    expect(own.find((t) => t.id === "newbie-recall")!.earlier?.length).toBe(1);
  });
});

describe("the runs", () => {
  test("a prompt replaces the words of its task and keeps its repository, its check and what follows", () => {
    const [p] = NEWBIE.filter((x) => x.id === "files-7");
    const base = laneTasks().find((t) => t.id === p!.task)!;
    const t = derive(p!, base);
    expect(t.prompt).toBe(p!.say);
    expect(t.then).toEqual([...p!.then!]);
    expect([t.check, t.dir, t.id]).toEqual([base.check, base.dir, base.id]);
    expect(derive(NEWBIE.find((x) => x.id === "skills-1")!, laneTasks().find((x) => x.id === "skill-multiline-frontmatter")!).touch?.map((c) => c.tool)).toEqual(["Skill"]);
  });

  test("a selection takes some tools, some prompts of each, and the plain tasks once for each tool", () => {
    const jobs = laneJobs({ tools: ["files", "ask"], perTool: 2, neat: true });
    expect(jobs.filter((j) => j.tag.lane === "newbie").map((j) => j.tag.prompt)).toEqual(["files-1", "files-2", "ask-1", "ask-2"]);
    expect(jobs.filter((j) => j.tag.lane === "neat").map((j) => j.task.id)).toEqual(["fix-off-by-one", "fix-sort-order", "ask-which-port"]);
    expect(laneJobs().length).toBe(NEWBIE.length);
  });

  test("the scripted model gets the task with the prompt's calls where a task is asked both ways", () => {
    const tasks = mockTasks(laneJobs({ tools: ["skills"], perTool: 1, neat: true }));
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.touch?.length).toBe(1);
  });
});

describe("the checker", () => {
  test("the outcome decides: a task whose check holds is solved with any tool, and the tools used are only reported", () => {
    expect(judge(tag("code"), result({ tools: { Bash: 3 } }))).toEqual({ outcome: true, rightTool: false, flags: ["solved"] });
    expect(judge(tag("web-fetch"), result({ tools: { Browser: 2 } })).flags).toEqual(["solved"]);
    expect(judge(tag("terminal"), result({ tools: { Read: 1, Bash: 1 } })).flags).toEqual(["solved"]);
  });

  test("a failed check is not solved, and is not flagged for the tool where the tool is not the result", () => {
    expect(judge(tag("web-fetch"), result({ passed: false, reason: "check failed", tools: { Bash: 2 } }))).toEqual({ outcome: false, rightTool: false, flags: [] });
    expect(judge(tag("memory"), result({ passed: false, reason: "check failed" })).flags).toEqual([]);
  });

  test("where the tool is the result, a run without it is flagged even when its check held", () => {
    for (const tool of ["schedule", "session-search", "todo", "ask", "skills"]) {
      expect(LANE_TOOLS[tool]!.strict, tool).toBe(true);
      expect(judge(tag(tool), result({ tools: { Bash: 2 } })), tool).toEqual({ outcome: true, rightTool: false, flags: ["wrong-tool"] });
      expect(judge(tag(tool), result({ passed: false, reason: "check failed" })).flags, tool).toEqual(["no-tool"]);
      expect(judge(tag(tool), result({ tools: { [LANE_TOOLS[tool]!.accept[0]!]: 1 } })).flags, tool).toEqual(["solved"]);
    }
    expect(judge(tag("schedule"), result({ passed: false, reason: "check failed", tools: { Schedule: 1 } })).flags).toEqual([]);
  });

  test("only those five rows are strict", () => {
    expect(Object.entries(LANE_TOOLS).filter(([, l]) => l.strict).map(([id]) => id).sort()).toEqual(["ask", "schedule", "session-search", "skills", "todo"]);
  });

  test("the plain task is solved when its check holds, with any tool", () => {
    expect(judge(tag("schedule", "neat"), result({ tools: { Bash: 2 } })).flags).toEqual(["solved"]);
  });

  test("where nothing can be done, saying so or asking is right, and making things up is not", () => {
    const t = tag("no-screen");
    expect(judge(t, result({ tools: { Read: 1 }, said: "Sorry, I cannot make use of the screen here." })).flags).toEqual(["solved"]);
    expect(judge(t, result({ said: `${CANNOT_WORDS.at(-4)!} bikin video` })).flags).toEqual(["solved"]);
    expect(judge(t, result({ said: "Which note do you mean?" })).flags).toEqual(["solved"]);
    expect(judge(t, result({ said: "Done, the first line is: open." })).flags).toEqual([]);
    expect(judge(t, result({ passed: false, reason: "check failed", said: "I cannot do it." })).flags).toEqual([]);
  });

  test("for a video, a program in the terminal is fine when the agent says what it did not check, and 'cannot, here is what I can do' is as good; a made-up result is not", () => {
    const t = tag("video-generation");
    expect(judge(t, result({ tools: { Bash: 2 }, said: "I made lighthouse.mp4 with ffmpeg from a drawn frame. I did not check how it looks." })).flags).toEqual(["solved"]);
    expect(judge(t, result({ tools: { Bash: 2 }, said: `I made it with ffmpeg, ${UNCHECKED_WORDS.at(-1)!}` })).flags).toEqual(["solved"]);
    expect(judge(t, result({ said: "I cannot generate video here, but I can make a slideshow from pictures with ffmpeg." })).flags).toEqual(["solved"]);
    expect(judge(t, result({ tools: { Bash: 2 }, said: "Done. The video of the lighthouse is ready and looks great." })).flags).toEqual([]);
    expect(judge(t, result({ passed: false, reason: "check failed", tools: { Write: 1 }, said: "I did not check it." })).flags).toEqual([]);
  });

  test("a tool is robust only when every plain task and every prompt is solved; the tool used is reported beside it", () => {
    const run = (lane: Tag["lane"], tool: string, o: Partial<TaskResult>): LaneResult => tagged(tag(tool, lane), result(o));
    const table = laneTable([
      run("neat", "files", { tools: { Read: 1 } }), run("newbie", "files", { tools: { Edit: 1 } }), run("newbie", "files", { tools: { Bash: 1 } }),
      run("neat", "terminal", { tools: { Bash: 1 } }), run("newbie", "terminal", { passed: false, reason: "check failed", tools: { Read: 1 } }),
      run("neat", "schedule", { tools: { Schedule: 1 } }), run("newbie", "schedule", { tools: { Bash: 1 } }),
      run("newbie", "todo", { tools: { TodoWrite: 1 } }),
    ]);
    const row = (title: string): string => table.split("\n").find((l) => l.startsWith(`| ${title} |`))!;
    expect(row("Files & Search")).toContain("| 1/1 | 2/2 | 1/2 | 0 | 0 | yes |");
    expect(row("Terminal & Processes")).toContain("| 1/1 | 0/1 | 0/1 | 0 | 0 | no |");
    expect(row("Schedule")).toContain("| 1/1 | 0/1 | 0/1 | 1 | 0 | no |");
    expect(row("Task Planning")).toContain("| - | 1/1 | 1/1 | 0 | 0 | not measured |");
    expect(row("Memory")).toContain("not run");
    expect(table).toContain("| terminal-x |");
  });
});

describe("the fixtures of the real engines", () => {
  test("a project skill is accepted in the state of the agent, by name and text", () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-trust-"));
    mkdirSync(join(dir, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Does a demo. Use it when asked for one.\n---\nSteps.\n");
    const env = { HOME: dir, XDG_STATE_HOME: join(dir, "state") };
    const skills = () => loadSkills({ project: projectSkillDirs(dir), trusted: new SkillTrust(skillTrustPath(env)).said });
    expect(skills().find((s) => s.name === "demo")?.trusted).toBe(false);
    trustSkills(dir, env);
    expect(skills().find((s) => s.name === "demo")?.trusted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("real engines replace the stand-ins for the tasks that use media, and are not given to the others", () => {
    const real = { stt: { bin: "/x/whisper", model: "/x/m" }, tts: { bin: "/x/piper", model: "/x/v" }, image: { bin: "/x/sd", model: "/x/i" }, vision: { local: { server: "/x/s", model: "/x/m", mmproj: "/x/p" } }, ffmpeg: "/usr/bin/ffmpeg" };
    const tasks = new Map(laneTasks().map((t) => [t.id, t]));
    const config = (id: string, media?: Record<string, unknown>): Record<string, unknown> | undefined => {
      const c = agentConfig(tasks.get(id)!, undefined, media);
      try { return c.env.NAVVIED_CONFIG ? (JSON.parse(readFileSync(c.env.NAVVIED_CONFIG, "utf8")) as { media?: Record<string, unknown> }).media : undefined; } finally { c.remove(); }
    };
    expect(config("media-speak-greeting", real)).toEqual(real);
    expect(config("newbie-watch-clip", real)).toEqual(real);
    expect(config("read-picture-label", real)).toEqual(real);
    expect(config("fix-off-by-one", real)).toBeUndefined();
    expect(Object.keys(config("media-speak-greeting")!)).toEqual(["tts", "ffmpeg"]);
    expect(config("read-picture-label")).toBeUndefined();
    expect(mediaEnv(real)).toEqual({ BENCH_TTS_BIN: "/x/piper", BENCH_TTS_MODEL: "/x/v" });
    expect(mediaEnv(undefined)).toEqual({});
  });

  test("the installed engines are found in a folder, or reported missing, and a folder that lacks one is not used", () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-media-"));
    expect(installedMedia(dir)).toBeUndefined();
    const env = { ...process.env, HOME: dir, XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config") };
    mkdirSync(dirname(configPath(env)), { recursive: true });
    const base = { stt: { bin: "/x/w", model: "/x/m" }, tts: { bin: "/x/p", model: "/x/v" }, image: { bin: "/x/s", model: "/x/i" } };
    writeFileSync(configPath(env), JSON.stringify({ default: "m", models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "none", window: 1000 } }, media: base }));
    expect(installedMedia(dir, () => null)).toBeUndefined();
    writeFileSync(configPath(env), JSON.stringify({ default: "m", models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "none", window: 1000 } }, media: { ...base, vision: { local: { server: "/x/s", model: "/x/m", mmproj: "/x/p" } } } }));
    expect(installedMedia(dir, (p) => (p === "ffmpeg" ? "/usr/bin/ffmpeg" : null))).toMatchObject({ ffmpeg: "/usr/bin/ffmpeg", stt: base.stt });
    rmSync(dir, { recursive: true, force: true });
  });

  test("the chart is a real picture with a label, and the label is also in its text chunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-chart-"));
    expect(Bun.spawnSync(["bun", join(import.meta.dir, "../fixtures/make-chart.ts"), join(dir, "chart.png")]).exitCode).toBe(0);
    const png = readFileSync(join(dir, "chart.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBeGreaterThan(300);
    expect(png.includes("bar label: revenue 42")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the checks a prompt may change", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const prompt = (id: string): (typeof NEWBIE)[number] => NEWBIE.find((p) => p.id === id)!;

  test("only a prompt written in capitals gets a file name in any case, and the check itself is the task's own", () => {
    const caps = derive(prompt("browser-4"), tasks.get("browser-confirm")!);
    expect(caps.check.endsWith(`; ${tasks.get("browser-confirm")!.check}`)).toBe(true);
    expect(caps.check).toContain("'ANSWER.txt'");
    expect(derive(prompt("browser-1"), tasks.get("browser-form")!).check).toBe(tasks.get("browser-form")!.check);
  });

  test("the names a task wants are the ones it makes, not the ones it starts with", () => {
    expect(wantedFiles(tasks.get("media-transcribe-note")!)).toEqual(["summary.txt"]);
    expect(wantedFiles(tasks.get("media-speak-greeting")!)).toEqual(["greeting.wav"]);
    expect(wantedFiles(tasks.get("memory-typo-forget")!)).toEqual(["ANSWER.txt"]);
  });

  test("a file named in other letters is copied to the wanted name, and nothing is made up for a name that has no file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-case-"));
    writeFileSync(join(dir, "ANSWER.TXT"), "x\n");
    writeFileSync(join(dir, "other.txt"), "y\n");
    const r = await shell(dir, `${caseFix(["ANSWER.txt", "summary.txt"])}; ls`);
    expect(r.ok).toBe(true);
    expect(r.output.split("\n").filter(Boolean).sort()).toEqual(["ANSWER.TXT", "ANSWER.txt", "other.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a wrong answer does not pass the checks that were relaxed, a right one in a sentence does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-contains-"));
    const run = async (check: string, files: Record<string, string>): Promise<boolean> => {
      for (const f of readdirSync(dir)) rmSync(join(dir, f));
      for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
      return (await shell(dir, check)).ok;
    };
    const recall = derive(prompt("session-search-2"), tasks.get("newbie-recall")!).check;
    expect(await run(recall, { "ANSWER.txt": "The ticket is ZX-4471.\n" })).toBe(true);
    expect(await run(recall, { "ANSWER.txt": "ZX-4417\n" })).toBe(false);
    expect(await run(recall, { "ANSWER.txt": "ZX-44712\n" })).toBe(false);
    expect(await run(recall, {})).toBe(false);
    const helpers = derive(prompt("helpers-3"), tasks.get("research-two-helpers")!).check;
    expect(await run(helpers, { "summary.txt": "alpha: heron\nbeta: otter\n" })).toBe(true);
    expect(await run(helpers, { "summary.txt": "otter\nheron\n" })).toBe(false);
    expect(await run(helpers, { "summary.txt": "heron\n" })).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a run that failed keeps what the agent wrote, so the check can be read against it", () => {
    const base = laneTasks().find((t) => t.id === "newbie-recall")!;
    const dir = prepare(base);
    writeFileSync(join(dir, "ANSWER.TXT"), "Ticket: ZX-4471\n");
    writeFileSync(join(dir, ".bench-events.jsonl"), "not shown");
    expect(changesOf(dir)).toBe('ANSWER.TXT: "Ticket: ZX-4471\\n"');
    rmSync(dir, { recursive: true, force: true });
  });

  test("the neat tasks keep their own exact checks", () => {
    expect(tasks.get("newbie-recall")!.check).toContain("= \"ZX-4471\"");
    expect(tasks.get("research-two-helpers")!.check).toContain("= heron");
  });

  test("computer use and no screen are two rows, each judged by its own runs", () => {
    const table = laneTable([
      tagged(tag("computer-use", "neat"), result({ tools: { computer: 2 } })), tagged(tag("computer-use"), result({ tools: { computer: 2 } })),
      tagged(tag("no-screen", "neat"), result({ said: "I cannot." })), tagged(tag("no-screen"), result({ said: "Done." })),
    ]);
    const row = (title: string): string => table.split("\n").find((l) => l.startsWith(`| ${title} |`))!;
    expect(row("Computer Use")).toContain("| 1/1 | 1/1 | 1/1 |");
    expect(row("Computer Use")).toContain("| yes |");
    expect(row("No screen here")).toContain("| 1/1 | 0/1 |");
    expect(row("No screen here")).toContain("| no |");
  });
});

describe("round 4: checks that were stricter than the prompt", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const check = (id: string): string => derive(NEWBIE.find((p) => p.id === id)!, tasks.get(NEWBIE.find((p) => p.id === id)!.task)!).check;
  const secret = "round4secret";
  const code = (n: string): string => createHash("sha1").update(`${secret}web${n}`).digest("hex").slice(0, 10);
  const env = { BENCH_SECRET: secret, BENCH_FIXTURES: join(import.meta.dir, "../fixtures") };
  const holds = async (command: string, files: Record<string, string>): Promise<boolean> => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-r4-"));
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
    try { return (await shell(dir, command, env)).ok; } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("terminal-1: the checksum the build printed may keep its label, on one line; another value or two lines may not", async () => {
    const sum = createHash("sha1").update(`${secret}build`).digest("hex").slice(0, 12);
    const c = check("terminal-1");
    expect(await holds(c, { "checksum.txt": `checksum: ${sum}\n` })).toBe(true);
    expect(await holds(c, { "checksum.txt": `${sum}\n` })).toBe(true);
    expect(await holds(c, { "checksum.txt": "checksum: 2bc218e63813\n" })).toBe(false);
    expect(await holds(c, { "checksum.txt": `checksum: ${sum}\nbuild finished\n` })).toBe(false);
    expect(await holds(c, {})).toBe(false);
    expect(tasks.get("term-long-build")!.check).toContain('= "$(python3');
  });

  test("web-search-3 and web-fetch-2: the current code first, the retired one named in a note is fine, and as the answer it is not", async () => {
    const search = check("web-search-3"), docs = check("web-fetch-2");
    expect(await holds(search, { "ANSWER.txt": `Current code: ${code("3")}\n\nNote: the digest says OLD${code("0")}, replaced.\n` })).toBe(true);
    expect(await holds(search, { "ANSWER.txt": `OLD${code("0")}\n` })).toBe(false);
    expect(await holds(search, { "ANSWER.txt": `Note: OLD${code("0")} is old\n\nCurrent code: ${code("3")}\n` })).toBe(false);
    expect(await holds(docs, { "ANSWER.txt": `Sync worker: ${code("1")}\n\nThe legacy worker has 0000000000 and is retired.\n` })).toBe(true);
    expect(await holds(docs, { "ANSWER.txt": "0000000000\n" })).toBe(false);
    expect(await holds(docs, { "ANSWER.txt": `Legacy 0000000000, sync ${code("1")}\n` })).toBe(false);
    expect(await holds(tasks.get("web-deep-docs")!.check, { "ANSWER.txt": `Sync worker: ${code("1")}\n\nThe legacy worker has 0000000000.\n` })).toBe(false);
  });

  test("todo-4: the words of a prompt in capitals may come back in capitals; a wrong word may not", async () => {
    const c = check("todo-4");
    expect(await holds(c, { "a.txt": "ALPHA\n", "b.txt": "BETA\n", "c.txt": "GAMMA\n" })).toBe(true);
    expect(await holds(c, { "a.txt": "alpha\n", "b.txt": "beta\n", "c.txt": "gamma\n" })).toBe(true);
    expect(await holds(c, { "a.txt": "ALPHA\n", "b.txt": "BETA\n", "c.txt": "DELTA\n" })).toBe(false);
    expect(await holds(c, { "a.txt": "alpha beta\n", "b.txt": "beta\n", "c.txt": "gamma\n" })).toBe(false);
    expect(tasks.get("plan-three-files")!.check).toContain("'^alpha$'");
  });

  const notes = (lines: string[]): string => `# What navvied remembers\n\n${lines.join("\n")}\n`;
  const memory = (id: string, files: Record<string, string>): Promise<boolean> => holds(check(id), files);

  test("memory-3: the corrected note holds the new command with the date the program shows, the others are as they were", async () => {
    const base = ["- 2026-11-01: The api lives in src/api <!--k3a001 self-->", "- 2026-11-03: Reviews are done by Dana <!--k3a003 user-->"];
    const done = (k3a002: string): Record<string, string> => ({ "ANSWER.txt": "k3a002\n", ".navvied/memory.md": notes([base[0]!, `- 2026-11-25: ${k3a002} <!--k3a002 self-->`, base[1]!]) });
    expect(await memory("memory-3", done("2026-11-02: Run tests with bun test --timeout 30000"))).toBe(true);
    expect(await memory("memory-3", done("Run tests with bun test --timeout 30000"))).toBe(true);
    expect(await memory("memory-3", done("Run tests with bun test"))).toBe(false);
    expect(await memory("memory-3", { ...done("Run tests with bun test --timeout 30000"), "ANSWER.txt": "k3a001\n" })).toBe(false);
    expect(await memory("memory-3", { ...done("Run tests with bun test --timeout 30000"), "ANSWER.txt": "k3a002 and k3a001\n" })).toBe(false);
    expect(await memory("memory-3", { ...done("Run tests with bun test --timeout 30000"), ".navvied/memory.md": notes([base[0]!, "- 2026-11-25: Run tests with bun test --timeout 30000 <!--k3a002 self-->"]) })).toBe(false);
    expect(tasks.get("memory-list-then-replace")!.check).toContain(" replaced");
  });

  test("memory-4 asks to forget the old note and keep the others, not to remember the new host: a new note is optional there and nowhere else", async () => {
    const keep = ["- 2026-11-02: Indent with tabs <!--k4a002 user-->", "- 2026-11-03: Run the database migrations before every deploy <!--k4a003 self-->"];
    const after = (lines: string[], answer = "beta.example.test\n"): Record<string, string> => ({ "ANSWER.txt": answer, ".navvied/memory.md": notes(lines) });
    const stale = "- 2026-11-01: The staging server is alpha.example.test <!--k4a001 self-->";
    expect(await memory("memory-4", after(keep))).toBe(true);
    expect(await memory("memory-4", after(keep, "alpha.example.test\n"))).toBe(false);
    expect(await memory("memory-4", after([stale, ...keep]))).toBe(false);
    expect(await memory("memory-4", after([keep[0]!]))).toBe(false);
    expect(await memory("memory-4", after([keep[0]!, "- 2026-11-25: The staging server is beta.example.test <!--0igwsj self-->"]))).toBe(false);
    expect(await memory("memory-4", after([...keep, "- 2026-11-25: Lunch is at noon <!--0igwsj self-->"]))).toBe(false);
    expect(await memory("memory-4", after([...keep, "- 2026-11-25: The staging server is beta.example.test <!--0igwsj self-->", "- 2026-11-25: Lunch is at noon <!--0igwsk self-->"]))).toBe(false);
    expect(await memory("memory-2", after(keep))).toBe(false);
    expect(await holds(tasks.get("memory-typo-forget")!.check, after(keep))).toBe(false);
  });

  test("memory-4 and the plain task: a new note may say where the host moved from, an old note that still says it is the host may not", async () => {
    const keep = ["- 2026-11-02: Indent with tabs <!--k4a002 user-->", "- 2026-11-03: Run the database migrations before every deploy <!--k4a003 self-->"];
    const done = (staging: string): Record<string, string> => ({ "ANSWER.txt": "beta.example.test\n", ".navvied/memory.md": notes([...keep, `- 2026-11-25: ${staging} <!--0igwsj self-->`]) });
    for (const id of ["memory-4"]) {
      expect(await memory(id, done("The staging server is beta.example.test (moved from alpha.example.test)"))).toBe(true);
      expect(await memory(id, done("The staging server is beta.example.test"))).toBe(true);
      expect(await memory(id, done("The staging server is alpha.example.test"))).toBe(false);
      expect(await memory(id, done("staging: alpha.example.test"))).toBe(false);
      expect(await memory(id, done("alpha.example.test (staging)"))).toBe(false);
      expect(await memory(id, done("Staging moved from alpha.example.test to beta.example.test"))).toBe(true);
    }
    expect(await holds(tasks.get("memory-typo-forget")!.check, done("The staging server is beta.example.test (moved from alpha.example.test)"))).toBe(true);
    expect(await holds(tasks.get("memory-typo-forget")!.check, { ...done("The staging server is beta.example.test"), ".navvied/memory.md": notes(["- 2026-11-01: The staging server is alpha.example.test <!--k4a001 self-->", ...keep, "- 2026-11-25: The staging server is beta.example.test <!--0igwsj self-->"]) })).toBe(false);
  });
});

describe("round 5: helpers-4 and the guard of protected files", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const helpers4 = derive(NEWBIE.find((p) => p.id === "helpers-4")!, tasks.get("research-two-helpers")!);
  const holds = async (files: Record<string, string>): Promise<boolean> => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-r5-"));
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
    try { return (await shell(dir, helpers4.check)).ok; } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("the summary may be at the project root or in docs/, in any case, with the same two lines", async () => {
    expect(await holds({ "summary.txt": "heron\notter\n" })).toBe(true);
    expect(await holds({ "SUMMARY.TXT": "heron\notter\n" })).toBe(true);
    expect(await holds({ "docs/summary.txt": "heron\notter\n" })).toBe(true);
    expect(await holds({ "docs/SUMMARY.TXT": "heron\notter\n" })).toBe(true);
  });

  test("the lines are still the task's own, and no summary is still no answer", async () => {
    expect(await holds({ "docs/summary.txt": "otter\nheron\n" })).toBe(false);
    expect(await holds({ "docs/summary.txt": "heron\n" })).toBe(false);
    expect(await holds({ "docs/summary.txt": "alpha: heron\nbeta: otter\n" })).toBe(true);
    expect(await holds({ "summary.txt": "heron otter\n" })).toBe(false);
    expect(await holds({ "summary.txt": "heron, otter\notter\n" })).toBe(false);
    expect(await holds({ "summary.txt": "otter: beta\nheron: alpha\n" })).toBe(false);
    expect(await holds({ "docs/notes.txt": "heron\notter\n" })).toBe(false);
    expect(await holds({})).toBe(false);
    expect(tasks.get("research-two-helpers")!.check).toContain("sed -n 1p summary.txt");
  });

  test("only a new summary.txt under docs/ is let into the protected folder; every other change of it still counts", () => {
    const before = { "docs/alpha.txt": "a", "docs/beta.txt": "b" };
    const allow = ["docs/summary.txt"];
    expect(helpers4.mayAdd).toEqual(allow);
    expect(protectedChanged(before, { ...before, "docs/summary.txt": "x" }, allow)).toBe(false);
    expect(protectedChanged(before, { ...before, "docs/SUMMARY.TXT": "x" }, allow)).toBe(false);
    expect(protectedChanged(before, { ...before, "docs/other.txt": "x" }, allow)).toBe(true);
    expect(protectedChanged(before, { ...before, "docs/summary.txt": "x", "docs/other.txt": "x" }, allow)).toBe(true);
    expect(protectedChanged(before, { ...before, "docs/alpha.txt": "changed" }, allow)).toBe(true);
    expect(protectedChanged(before, { "docs/beta.txt": "b" }, allow)).toBe(true);
    expect(protectedChanged(before, { ...before, "docs/summary.txt": "x" })).toBe(true);
    expect(protectedChanged({ ...before, "docs/summary.txt": "old" }, { ...before, "docs/summary.txt": "new" }, allow)).toBe(true);
    expect(tasks.get("research-two-helpers")!.mayAdd).toBeUndefined();
    for (const id of ["helpers-1", "helpers-2", "helpers-3", "helpers-5"]) expect(derive(NEWBIE.find((p) => p.id === id)!, tasks.get("research-two-helpers")!).mayAdd, id).toEqual(allow);
    expect(derive(NEWBIE.find((p) => p.id === "files-1")!, tasks.get("fix-off-by-one")!).mayAdd).toBeUndefined();
  });

  test("--tools takes the ids of the Tools list, and says which are wrong", async () => {
    const ids = ["code", "web-fetch", "ask", "todo", "helpers", "session-search"];
    for (const id of ids) expect(TOOL_ROWS.some((r) => r.id === id), id).toBe(true);
    expect(laneJobs({ tools: ids, neat: true }).filter((j) => j.tag.lane === "newbie").length).toBe(ids.reduce((n, id) => n + NEWBIE.filter((p) => p.tool === id).length, 0));
    expect(await main(["run", "--lane", "newbie", "--mock", "oracle", "--tools", "code,files-and-search"])).toBe(2);
  });
});

describe("the estimate", () => {
  test("one repeat of every prompt is expected to fit the budget when a first request is small, and grows with the follow-ups", () => {
    const jobs = laneJobs({ neat: true });
    const first = Object.fromEntries(jobs.map((j) => [j.task.id, 3000]));
    const e = estimateLane(jobs, first);
    expect(e.total.jobs).toBe(jobs.length);
    expect(e.total.tokens).toBeGreaterThan(0);
    expect(Object.keys(e.byTool).sort()).toEqual(Object.keys(CALLS).sort());
    const a = estimateLane(laneJobs({ tools: ["files"], perTool: 1 }), { "fix-off-by-one": 3000 });
    const withMore = estimateLane(laneJobs({ tools: ["files"], perTool: 7 }), Object.fromEntries(laneTasks().map((t) => [t.id, 3000])));
    expect(withMore.total.tokens).toBeGreaterThan(a.total.tokens);
    expect(estimateTable(e, 2)).toContain(`${e.total.jobs * 2} runs`);
  });
});

// The scripted model ignores the words: what these runs prove is that the plumbing and the checkers work for every kind of task of the lane.
describe("the lane with the scripted model", () => {
  const out = join(mkdtempSync(join(tmpdir(), "navvied-newbie-test-")), "r.jsonl");

  test("a follow-up, an earlier conversation, a plain tool and a thing that cannot be done are all solved, and the results carry the verdict", async () => {
    const code = await main(["run", "--lane", "newbie", "--mock", "oracle", "--tools", "files,session-search,computer-use,no-screen,todo", "--per-tool", "2", "--tasks", "deep-merge,fix-off-by-one,fix-sort-order,newbie-recall,newbie-notes-door,newbie-cannot-computer,plan-three-files", "--with-neat", "--out", out]);
    expect(code).toBe(0);
    const rows = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LaneResult);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.every((r) => r.verdict.flags.includes("solved"))).toBe(true);
    expect(rows.find((r) => r.tag.prompt === "session-search-1")!.tools).toMatchObject({ Recall: 1 });
    expect(rows.some((r) => r.tag.lane === "neat")).toBe(true);
    for (const r of rows.filter((r) => r.tag.tool === "computer-use")) expect(r.tools).toMatchObject({ computer: 3 });
    expect(rows.filter((r) => r.tag.tool === "no-screen").every((r) => !r.tools?.computer)).toBe(true);
  }, 120_000);

  test("a model that says it looked and does nothing is flagged, and the run fails", async () => {
    const lazy = join(mkdtempSync(join(tmpdir(), "navvied-newbie-test-")), "r.jsonl");
    expect(await main(["run", "--lane", "newbie", "--mock", "lazy", "--tools", "schedule,video-generation", "--per-tool", "1", "--out", lazy])).toBe(1);
    const rows = readFileSync(lazy, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LaneResult);
    expect(rows.map((r) => r.verdict.flags)).toEqual([["no-tool"], []]);
  }, 120_000);

  test("a real model is not asked without a limit and a yes", async () => {
    expect(await main(["run", "--lane", "newbie", "--upstream", "http://127.0.0.1:1/v1", "--upstream-model", "m"])).toBe(2);
    expect(await main(["run", "--lane", "newbie", "--upstream", "http://127.0.0.1:1/v1", "--upstream-model", "m", "--max-tokens", "1000"])).toBe(2);
    expect(existsSync(out)).toBe(true);
  });
});

describe("code-4: no format was asked, so a module may be named three ways", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const prompt = NEWBIE.find((p) => p.id === "code-4")!;
  const check = derive(prompt, tasks.get(prompt.task)!).check;
  const env = { BENCH_SECRET: "code4secret", BENCH_FIXTURES: join(import.meta.dir, "../fixtures") };

  test("the bare name, with .ts and with src/ pass; the set and the order stay exact; the plain task takes the bare name only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-c4-"));
    try {
      expect((await shell(dir, 'python3 "$BENCH_FIXTURES/mc.py" setup import-cycles', env)).ok).toBe(true);
      const right = (await shell(dir, `python3 -c "import sys; sys.path.insert(0, '$BENCH_FIXTURES'); import mc; print(*mc.modules()[1])"`, env)).output.trim().split(" ");
      expect(right.length).toBeGreaterThan(2);
      const holds = async (lines: string[], command = check): Promise<boolean> => { writeFileSync(join(dir, "cycles.txt"), `${lines.join("\n")}\n`); return (await shell(dir, command, env)).ok; };
      for (const form of [(m: string) => m, (m: string) => `${m}.ts`, (m: string) => `src/${m}.ts`, (m: string) => `src/${m}`]) expect(await holds(right.map(form))).toBe(true);
      const paths = right.map((m) => `src/${m}.ts`);
      expect(await holds(paths.slice(1))).toBe(false);
      expect(await holds([...paths, "src/m99.ts"])).toBe(false);
      expect(await holds([...paths, paths[0]!])).toBe(false);
      expect(await holds([...paths].reverse())).toBe(false);
      expect(await holds(right.map((m) => `lib/${m}.ts`))).toBe(false);
      expect(await holds(right.map((m) => `${m}.js`))).toBe(false);
      expect(await holds([paths.join(" ")])).toBe(false);
      const plain = tasks.get("mc-import-cycles")!.check;
      expect(await holds(right, plain)).toBe(true);
      expect(await holds(paths, plain)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("the import-cycle answer may sit in src/ when the final answer names the file and that folder", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const newbie = NEWBIE.find((p) => p.id === "code-4")!;
  const checkers = { plain: tasks.get("mc-import-cycles")!.check, newbie: derive(newbie, tasks.get(newbie.task)!).check };
  const env = { BENCH_SECRET: "cyclefolder", BENCH_FIXTURES: join(import.meta.dir, "../fixtures"), PYTHONDONTWRITEBYTECODE: "1" };
  const named = "I wrote `src/cycles.txt` with the modules.";

  test.each(Object.entries(checkers))("%s checker: project folder or named src/; an unnamed src/ file, a third folder and a wrong list fail", async (_which, command) => {
    const base = mkdtempSync(join(tmpdir(), "navvied-newbie-cycfolder-"));
    try {
      expect((await shell(base, 'python3 "$BENCH_FIXTURES/mc.py" setup import-cycles', env)).ok).toBe(true);
      const right = (await shell(base, `python3 -c "import sys; sys.path.insert(0, '$BENCH_FIXTURES'); import mc; print(*mc.modules()[1])"`, env)).output.trim().split(" ");
      const holds = async (files: Record<string, string[]>, answer: string): Promise<boolean> => {
        const paths = Object.keys(files).map((f) => join(base, f));
        for (const [f, lines] of Object.entries(files)) { mkdirSync(dirname(join(base, f)), { recursive: true }); writeFileSync(join(base, f), `${lines.join("\n")}\n`); }
        try { return (await check(base, { check: command }, 120_000, env, answer)).ok; } finally { for (const p of paths) { rmSync(p, { force: true }); rmSync(`${p}.orig`, { force: true }); } }
      };
      expect(await holds({ "cycles.txt": right }, "")).toBe(true);
      expect(await holds({ "src/cycles.txt": right }, named)).toBe(true);
      expect(await holds({ "src/cycles.txt": right }, "")).toBe(false);
      expect(await holds({ "src/cycles.txt": right }, "I wrote cycles.txt.")).toBe(false);
      expect(await holds({ "src/cycles.txt": right }, "I wrote `cycles.txt` to `src/`, where the modules are.")).toBe(true);
      expect(await holds({ "src/cycles.txt": right }, "The list is in src/, as asked.")).toBe(false);
      expect(await holds({ "src/cycles.txt": right }, "I wrote cycles.txt; the sources have a cycle.")).toBe(false);
      expect(await holds({ "src/cycles.txt": right.slice(1) }, "I wrote cycles.txt to src/.")).toBe(false);
      expect(await holds({ "out/cycles.txt": right }, "I wrote cycles.txt to out/.")).toBe(false);
      expect(await holds({ "out/cycles.txt": right }, "I wrote out/cycles.txt.")).toBe(false);
      expect(await holds({ "out/cycles.txt": right }, named)).toBe(false);
      expect(await holds({ "src/cycles.txt": right.slice(1) }, named)).toBe(false);
      expect(await holds({ "src/cycles.txt": [...right].reverse() }, named)).toBe(false);
      expect(await holds({ "cycles.txt": right.slice(1), "src/cycles.txt": right }, named)).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 60_000);
});

describe("the final answer is what was written after the last tool call", () => {
  test("a path named before the last step is not in the final answer", async () => {
    const { measure } = await import("../src/run.ts");
    const line = (o: object): string => JSON.stringify(o);
    const out = [
      line({ ev: "text", text: "I will write src/cycles.txt. ", seq: 1, eid: "e1" }),
      line({ ev: "tool", id: "1", name: "Bash", status: "done", output: "ok", seq: 2, eid: "e2" }),
      line({ ev: "text", text: "Done, ", seq: 3, eid: "e3" }),
      line({ ev: "text", text: "the list is written.", seq: 4, eid: "e4" }),
    ].join("\n");
    expect(measure(out).answer).toBe("Done, the list is written.");
    expect(measure(out).said).toContain("src/cycles.txt");
  });
});

describe("computer use is judged with a screen, and 'no screen here' apart from it", () => {
  const tasks = new Map(laneTasks().map((t) => [t.id, t]));
  const of = (tool: string) => NEWBIE.filter((p) => p.tool === tool);

  test("the five asks are the same words in both rows, one row on the task with the screen and one on the task without", () => {
    expect(of("computer-use").map((p) => p.id)).toEqual([1, 2, 3, 4, 5].map((n) => `computer-use-${n}`));
    expect(of("no-screen").map((p) => p.id)).toEqual([1, 2, 3, 4, 5].map((n) => `no-screen-${n}`));
    expect(of("computer-use").map((p) => [p.say, p.styles])).toEqual(of("no-screen").map((p) => [p.say, p.styles]));
    expect(new Set(of("computer-use").map((p) => p.task))).toEqual(new Set(["newbie-notes-door"]));
    expect(new Set(of("no-screen").map((p) => p.task))).toEqual(new Set(["newbie-cannot-computer"]));
    const task = tasks.get("newbie-notes-door")!;
    expect(task).toMatchObject({ runner: "computer-run.ts", env: { BENCH_COMPUTER: "notes" }, protect: ["README.md"] });
    expect(readFileSync(join(task.dir, "repo/README.md"), "utf8")).toStartWith("# Notes");
  });

  const env = { BENCH_SECRET: "notesdoor", BENCH_FIXTURES: join(import.meta.dir, "../fixtures"), PYTHONDONTWRITEBYTECODE: "1" };
  const codeOfNote = (n: string): string => createHash("sha1").update(`notesdoorscreen${n}`).digest("hex").slice(0, 10);
  const click = (target: number): string => JSON.stringify({ action: "click", app: "Notes", target, verdict: "delivered" });

  test.each(["computer-use-1", "computer-use-3"])("%s: Door's own code passes, however it is worded; the README line, another note's code, a pressed Delete and no answer fail", async (id) => {
    const command = derive(NEWBIE.find((p) => p.id === id)!, tasks.get("newbie-notes-door")!).check;
    const holds = async (files: Record<string, string>): Promise<boolean> => {
      const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-door-"));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      try { return (await shell(dir, command, env)).ok; } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const door = `Door note ${codeOfNote("8")}\n`;
    const looked = `${click(3)}\n`;
    expect(await holds({ "ANSWER.txt": door, ".bench-computer.log": looked })).toBe(true);
    expect(await holds({ "ANSWER.txt": `The first line is: ${codeOfNote("8")}\n`, ".bench-computer.log": `${click(2)}\n${click(8)}\n${looked}` })).toBe(true);
    expect(await holds({ ".bench-computer.log": looked })).toBe(false);
    expect(await holds({ "ANSWER.txt": "# Notes\n", ".bench-computer.log": "" })).toBe(false);
    expect(await holds({ "ANSWER.txt": `${codeOfNote("9")}\n`, ".bench-computer.log": looked })).toBe(false);
    expect(await holds({ "ANSWER.txt": `${door}${codeOfNote("10")}\n`, ".bench-computer.log": looked })).toBe(false);
    expect(await holds({ "ANSWER.txt": door, ".bench-computer.log": `${looked}${click(9)}\n` })).toBe(false);
    if (id === "computer-use-3") expect(await holds({ "answer.txt": door, ".bench-computer.log": looked })).toBe(true);
  });

  test("the scripted screen shows each note's own code, and Delete takes the note away", async () => {
    const { screenOf } = await import("../fixtures/computer-worlds.ts");
    const dir = mkdtempSync(join(tmpdir(), "navvied-newbie-world-"));
    try {
      const screen = screenOf("notes", "notesdoor", dir);
      const show = async (target?: number): Promise<string> => { if (target !== undefined) await screen.call({ action: "click", app: "Notes", target }); return (await screen.call({ action: "capture", app: "Notes", mode: "ax" })).tree ?? ""; };
      const list = await show();
      for (const words of ['note "Gate"', 'note "Door"', 'note "Doors (old)"', 'button "Delete"']) expect(list).toContain(words);
      for (const [target, code] of [[3, "8"], [2, "9"], [4, "10"]] as const) {
        const open = await show(target);
        for (const other of ["8", "9", "10"]) expect(open.includes(codeOfNote(other)), `${target} ${other}`).toBe(other === code);
        await show(7);
      }
      expect(await show(9)).toContain("deleted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
