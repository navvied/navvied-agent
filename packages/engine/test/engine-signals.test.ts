import { describe, expect, test } from "bun:test";
import { approvalChange } from "../src/approval-change.ts";
import { Jobs } from "../src/jobs.ts";
import type { EngineEvent } from "@navvied/protocol";
import { afterAll } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("approval change", () => {
  test("an edit carries the file and both texts", () => {
    expect(approvalChange("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({ tool: "Edit", file: "a.ts", old: "x", new: "y" });
  });
  test("a write carries the content and a command carries the command", () => {
    expect(approvalChange("Write", { file_path: "a.ts", content: "hi" })).toEqual({ tool: "Write", file: "a.ts", content: "hi" });
    expect(approvalChange("Bash", { command: "ls" })).toEqual({ tool: "Bash", command: "ls" });
  });
  test("long text is cut and marked", () => {
    const c = approvalChange("Write", { file_path: "a", content: "z".repeat(25_000) });
    expect(c && "content" in c && c.content.length).toBe(20_000);
    expect(c?.truncated).toBe(true);
  });
  test("other tools have none", () => { expect(approvalChange("WebFetch", { url: "https://x.y" })).toBeUndefined(); });
});

describe("job events", () => {
  test("start carries startedAt and the end carries the last line", async () => {
    const events: EngineEvent[] = [];
    const jobs = new Jobs((e) => events.push(e), () => 1234);
    jobs.start([process.execPath, "-e", "console.log('one');console.log('two')"], process.cwd(), "demo");
    for (let i = 0; i < 100 && events.length < 2; i++) await Bun.sleep(50);
    jobs.close();
    expect(events[0]).toMatchObject({ ev: "job", status: "running", startedAt: 1234 });
    expect(events[1]).toMatchObject({ ev: "job", status: "done", code: 0, last: "two", startedAt: 1234 });
  });
});

describe("through the engine", () => {
  test("thinking ends once, with its duration, before the answer", async () => {
    const r = rig(() => ({ thought: "let me see", text: "hello" }));
    await r.turn(prompt("hi"));
    const kinds: string[] = r.events.map((e) => e.ev).filter((k) => k === "thought" || k === "thought_end" || k === "text");
    expect(kinds.slice(0, 3)).toEqual(["thought", "thought_end", "text"]);
    expect(r.of("thought_end")).toHaveLength(1);
    expect(r.of("thought_end")[0]!.ms).toBeGreaterThanOrEqual(0);
    r.cleanup();
  });

  test("no thinking, no thought_end", async () => {
    const r = rig(() => ({ text: "hello" }));
    await r.turn(prompt("hi"));
    expect(r.of("thought_end")).toHaveLength(0);
    r.cleanup();
  });

  test("an edit waiting for approval shows what it would change", async () => {
    const r = rig((req) => req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Edit", args: { file_path: "f.txt", old_string: "a", new_string: "b" } }] });
    r.send(prompt("edit", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    expect(r.of("approval")[0]!.change).toEqual({ tool: "Edit", file: "f.txt", old: "a", new: "b" });
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny" });
    await r.engine.idle();
    r.cleanup();
  });

  test("job.stop ends a running background command and ignores unknown ids", async () => {
    const r = rig((req) => req.messages.at(-1)?.role === "tool" ? { text: "started" } : { calls: [{ name: "Bash", args: { command: "sleep 30", run_in_background: true, description: "wait" } }] });
    await r.turn(prompt("go", { mode: "auto" }));
    const job = r.of("job")[0]!;
    expect(job.status).toBe("running");
    r.send({ cmd: "job.stop", id: "nope" });
    r.send({ cmd: "job.stop", id: job.id });
    await until(() => r.of("job").some((e) => e.status === "stopped"));
    expect(r.of("job").at(-1)).toMatchObject({ id: job.id, status: "stopped" });
    r.cleanup();
  });
});
