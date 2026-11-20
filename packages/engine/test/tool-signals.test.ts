import { afterAll, describe, expect, test } from "bun:test";
import { Rules } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

type Tool = Extract<import("@navvied/protocol").EngineEvent, { ev: "tool" }>;
const scripted = (name: string, args: object) => (req: { messages: { role: string }[] }) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : { calls: [{ name, args }] });
const toolEvents = (r: ReturnType<typeof rig>): Tool[] => r.events.filter((e): e is Tool => e.ev === "tool");

describe("what a step says about how it went", () => {
  test("a command that works says how long it took and its exit code; one that fails says its code", async () => {
    const ok = rig(scripted("Bash", { command: "echo hi" }));
    await ok.turn(prompt("go", { mode: "auto" }));
    const end = toolEvents(ok).at(-1)!;
    expect(end).toMatchObject({ status: "done", code: 0 });
    expect(end.ms).toBeGreaterThanOrEqual(0);
    expect(end.outcome).toBeUndefined();
    ok.cleanup();
    const bad = rig(scripted("Bash", { command: "exit 3" }));
    await bad.turn(prompt("go", { mode: "auto" }));
    expect(toolEvents(bad).at(-1)).toMatchObject({ code: 3 });
    bad.cleanup();
  });
  test("what a command prints arrives as it prints, and the end still has all of it", async () => {
    const r = rig(scripted("Bash", { command: "echo one; sleep 0.4; echo two" }));
    await r.turn(prompt("go", { mode: "auto" }));
    const live = toolEvents(r).filter((e) => e.live !== undefined).map((e) => e.live).join("");
    expect(live).toContain("one");
    expect(live).toContain("two");
    expect(toolEvents(r).filter((e) => e.live !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(toolEvents(r).at(-1)!.output).toContain("two");
    r.cleanup();
  });
  test("a command that runs out of time goes on as a job, and long output says it was cut", async () => {
    const slow = rig(scripted("Bash", { command: "sleep 5", timeout: 1 }));
    await slow.turn(prompt("go", { mode: "auto" }), 20_000);
    expect(toolEvents(slow).at(-1)).toMatchObject({ status: "done", outcome: "background" });
    slow.cleanup();
    const long = rig(scripted("Bash", { command: "head -c 60000 /dev/zero | tr '\\0' 'x'" }));
    await long.turn(prompt("go", { mode: "auto" }));
    expect(toolEvents(long).at(-1)).toMatchObject({ status: "done", truncated: true });
    long.cleanup();
  });
  test("a command started in the background says so, and a refusal says who refused", async () => {
    const bg = rig(scripted("Bash", { command: "sleep 30", run_in_background: true }));
    await bg.turn(prompt("go", { mode: "auto" }));
    expect(toolEvents(bg).at(-1)).toMatchObject({ status: "done", outcome: "background" });
    bg.engine.close();
    bg.cleanup();
    const blocked = rig(scripted("Bash", { command: "rm -rf /" }));
    await blocked.turn(prompt("go", { mode: "auto" }));
    expect(toolEvents(blocked).at(-1)).toMatchObject({ status: "error", outcome: "blocked" });
    blocked.cleanup();
    const ruled = rig(scripted("Bash", { command: "rm x" }), { rules: new Rules({ allow: [], ask: [], deny: ["Bash(rm *)"] }, "/") });
    await ruled.turn(prompt("go", { mode: "auto" }));
    expect(toolEvents(ruled).at(-1)).toMatchObject({ outcome: "blocked" });
    ruled.cleanup();
    const denied = rig(scripted("Bash", { command: "echo no" }));
    denied.send(prompt("go", { mode: "ask" }));
    await until(() => denied.of("approval").length === 1);
    denied.send({ cmd: "approve", id: denied.of("approval")[0]!.id, optionId: "deny" });
    await denied.engine.idle();
    expect(toolEvents(denied).at(-1)).toMatchObject({ status: "error", outcome: "denied" });
    denied.cleanup();
  });
});

describe("changing a command before allowing it", () => {
  const answer = async (command: string, reply: { optionId: string; input?: string }, rules?: Rules) => {
    const r = rig(scripted("Bash", { command }), rules ? { rules } : {});
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    const card = r.of("approval")[0]!;
    r.send({ cmd: "approve", id: card.id, ...reply });
    await r.engine.idle();
    return { r, card };
  };
  test("a command offers Edit with its text; what the person typed is what runs, and the step shows it", async () => {
    const { r, card } = await answer("echo original", { optionId: "edit", input: "echo changed" });
    expect(card.options.find((o) => o.optionId === "edit")).toMatchObject({ kind: "allow_once", editable: { value: "echo original" } });
    expect(toolEvents(r).filter((e) => e.input !== undefined).map((e) => (e.input as { command: string }).command)).toEqual(["echo original", "echo changed"]);
    expect(toolEvents(r).at(-1)!.output).toContain("changed");
    r.cleanup();
  });
  test("an edited command is held to the same limits: what is never done is stopped, and a deny rule still applies", async () => {
    const never = await answer("echo fine", { optionId: "edit", input: "rm -rf /" });
    expect(toolEvents(never.r).at(-1)).toMatchObject({ outcome: "blocked" });
    never.r.cleanup();
    const ruled = await answer("echo fine", { optionId: "edit", input: "rm file" }, new Rules({ allow: [], ask: [], deny: ["Bash(rm *)"] }, "/"));
    expect(toolEvents(ruled.r).at(-1)).toMatchObject({ outcome: "blocked" });
    ruled.r.cleanup();
  });
  test("only a command can be edited, and editing with nothing typed just allows the original", async () => {
    const file = rig(scripted("Write", { file_path: "a.txt", content: "x" }));
    file.send(prompt("go", { mode: "ask" }));
    await until(() => file.of("approval").length === 1);
    expect(file.of("approval")[0]!.options.some((o) => o.optionId === "edit")).toBe(false);
    file.send({ cmd: "approve", id: file.of("approval")[0]!.id, optionId: "deny" });
    await file.engine.idle();
    file.cleanup();
    const { r } = await answer("echo original", { optionId: "edit" });
    expect(toolEvents(r).at(-1)!.output).toContain("original");
    r.cleanup();
  });
});

describe("several steps in one go", () => {
  test("the ones that wait are shown as waiting, and each starts when its turn comes", async () => {
    let n = 0;
    const r = rig((req) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : n++ === 0 ? { calls: [{ name: "Bash", args: { command: "echo a" } }, { name: "Bash", args: { command: "echo b" } }, { name: "Bash", args: { command: "echo c" } }] } : { text: "done" }));
    await r.turn(prompt("go", { mode: "auto" }));
    const events = toolEvents(r);
    expect(events.filter((e) => e.queued).length).toBe(2);
    const first = events.findIndex((e) => e.id !== events[0]!.id && e.queued);
    expect(first).toBeGreaterThan(0);
    expect(events.filter((e) => e.status === "done").length).toBe(3);
    r.cleanup();
  });
  test("when the turn is stopped, the steps that never started are skipped", async () => {
    let n = 0;
    const r = rig((req) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : n++ === 0 ? { calls: [{ name: "Bash", args: { command: "sleep 5" } }, { name: "Bash", args: { command: "echo never" } }] } : { text: "done" }));
    r.send(prompt("go", { mode: "auto" }));
    await until(() => toolEvents(r).some((e) => e.status === "running" && !e.queued && e.input !== undefined));
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    const skipped = toolEvents(r).filter((e) => e.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    expect(toolEvents(r).some((e) => e.outcome === "stopped")).toBe(true);
    r.cleanup();
  });
});
