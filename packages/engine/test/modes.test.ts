import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rules } from "../src/index.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const scripted = (name: string, args: object) => (req: { messages: { role: string }[] }) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : { calls: [{ name, args }] });
type Mode = "ask" | "edits" | "plan" | "auto" | "bypass";
/** Runs one tool call in a mode and says whether the person was asked, and whether it ran. */
async function attempt(mode: Mode, name: string, args: object, options: Record<string, unknown> = {}, answer: "allow" | "deny" = "deny") {
  const r = rig(scripted(name, args), options);
  r.send(prompt("go", { mode }));
  await until(() => r.of("approval").length === 1 || r.of("done").length === 1);
  const asked = r.of("approval").length === 1;
  const card = r.of("approval")[0];
  if (asked) r.send({ cmd: "approve", id: card!.id, optionId: answer });
  await r.engine.idle();
  const ended = r.events.filter((e) => e.ev === "tool" && e.status !== "running").at(-1) as { status?: string; outcome?: string } | undefined;
  const ran = ended?.status === "done";
  const out = { asked, ran, ended, card, dir: r.dir, r };
  return out;
}

describe("Ask first", () => {
  test("a plain look is not asked about; a change is", async () => {
    const look = await attempt("ask", "Bash", { command: "ls -la && git status" });
    expect(look).toMatchObject({ asked: false, ran: true });
    look.r.cleanup();
    const change = await attempt("ask", "Write", { file_path: "a.txt", content: "x" });
    expect(change).toMatchObject({ asked: true, ran: false });
    change.r.cleanup();
  });
});

describe("Accept edits", () => {
  test("file edits and plain file commands go through, other commands are asked", async () => {
    const edit = await attempt("edits", "Write", { file_path: "a.txt", content: "x" });
    expect(edit).toMatchObject({ asked: false, ran: true });
    expect(existsSync(join(edit.dir, "a.txt"))).toBe(true);
    edit.r.cleanup();
    const mk = await attempt("edits", "Bash", { command: "mkdir made && touch made/f" });
    expect(mk).toMatchObject({ asked: false, ran: true });
    mk.r.cleanup();
    const other = await attempt("edits", "Bash", { command: "npm install left-pad" });
    expect(other).toMatchObject({ asked: true, ran: false });
    other.r.cleanup();
  });
  test("a setup file is still asked about", async () => {
    const protectedFile = await attempt("edits", "Write", { file_path: ".git/hooks/pre-commit", content: "x" });
    expect(protectedFile.asked).toBe(true);
    expect(protectedFile.card!.risk).toContain("sets up your shell");
    protectedFile.r.cleanup();
  });
});

describe("Auto", () => {
  test("it runs without asking, but what cannot be undone is asked about, with the reason", async () => {
    const fine = await attempt("auto", "Bash", { command: "echo hi > out.txt && git add -A" });
    expect(fine).toMatchObject({ asked: false, ran: true });
    fine.r.cleanup();
    const forced = await attempt("auto", "Bash", { command: "git push --force origin main" });
    expect(forced).toMatchObject({ asked: true, ran: false });
    expect(forced.card!.risk).toContain("rewrites the history");
    expect(forced.card!.options.find((o) => o.optionId === "allow_always")!.name).toBe("Allow, and do not ask again for force pushes");
    forced.r.cleanup();
  });

  test("a rule that allows git does not allow a force push, but does allow the rest of git", async () => {
    const rules = new Rules({ allow: ["Bash(git *)"], ask: [], deny: [] }, "/");
    const add = await attempt("ask", "Bash", { command: "git add -A" }, { rules });
    expect(add).toMatchObject({ asked: false });
    add.r.cleanup();
    const reset = await attempt("ask", "Bash", { command: "git reset --hard HEAD~1" }, { rules });
    expect(reset).toMatchObject({ asked: true, ran: false });
    reset.r.cleanup();
  });

  test("'do not ask again' covers that kind of thing and nothing else", async () => {
    const r = rig((req) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: "git push --force origin x" } }] }));
    r.send(prompt("one", { mode: "auto" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    // The same kind is now allowed in this conversation (it fails here only because there is no remote), another kind is not.
    r.send(prompt("two", { mode: "auto" }));
    await r.engine.idle();
    expect(r.of("approval")).toHaveLength(1);
    r.cleanup();
    const other = rig(scripted("Bash", { command: "git reset --hard" }));
    other.send(prompt("go", { mode: "auto" }));
    await until(() => other.of("approval").length === 1);
    expect(other.of("approval")).toHaveLength(1);
    other.send({ cmd: "approve", id: other.of("approval")[0]!.id, optionId: "deny" });
    await other.engine.idle();
    other.cleanup();
  });

  test("a rule that says ask is asked about in every mode, and a deny rule blocks", async () => {
    const rules = new Rules({ allow: [], ask: ["Bash(npm publish*)"], deny: ["Bash(rm *)"] }, "/");
    const ask = await attempt("auto", "Bash", { command: "npm publish --dry-run" }, { rules });
    expect(ask.asked).toBe(true);
    ask.r.cleanup();
    const bypassAsk = await attempt("bypass", "Bash", { command: "npm publish --dry-run" }, { rules });
    expect(bypassAsk.asked).toBe(true);
    bypassAsk.r.cleanup();
    const denied = await attempt("bypass", "Bash", { command: "rm a.txt" }, { rules });
    expect(denied).toMatchObject({ asked: false, ran: false });
    denied.r.cleanup();
  });
});

describe("Bypass", () => {
  test("nothing is asked, even for what Auto asks about; what is never done is still stopped", async () => {
    const forced = await attempt("bypass", "Bash", { command: "git push --force origin main" });
    expect(forced.asked).toBe(false);
    forced.r.cleanup();
    const never = await attempt("bypass", "Bash", { command: "rm -rf /" });
    expect(never).toMatchObject({ asked: false, ran: false });
    expect(never.ended?.outcome).toBe("blocked");
    never.r.cleanup();
  });
});

describe("a helper cannot be asked", () => {
  test("what would be asked is refused, so a helper never waits for an answer nobody can give", async () => {
    // The helper's engine is made without anyone to ask: tested through the option itself.
    const r = rig(scripted("Bash", { command: "git reset --hard" }), { noQuestions: true });
    r.send(prompt("go", { mode: "auto" }));
    await r.engine.idle();
    expect(r.of("approval")).toHaveLength(0);
    expect(r.events.some((e) => e.ev === "tool" && e.status === "error" && /cannot ask/.test((e as { output?: string }).output ?? ""))).toBe(true);
    r.cleanup();
  });
});
