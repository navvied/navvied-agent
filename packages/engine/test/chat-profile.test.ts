import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAll, prompt, rig } from "./helpers.ts";
import { place } from "../src/tools/util.ts";
import { profileTools } from "../src/profiles.ts";
import { defaultTools } from "../src/tools/index.ts";

afterAll(cleanupAll);

const names = (r: ReturnType<typeof rig>): string[] => r.provider.requests[0]!.tools.map((t) => t.name).sort();

describe("a chat is not an agent", () => {
  test("its tools are the conversation's: the web, files in its own folder, memory; commands only in a sandbox; no helpers, skills, browser, task list", () => {
    const all = defaultTools();
    const chat = profileTools("chat", all, { sandboxed: false }).map((t) => t.name).sort();
    expect(chat).toEqual(["Edit", "Glob", "Grep", "Read", "Remember", "WebFetch", "WebSearch", "Write"]);
    const boxed = profileTools("chat", all, { sandboxed: true }).map((t) => t.name);
    expect(boxed).toEqual(expect.arrayContaining(["Bash", "BashOutput", "KillShell", "Read"]));
    for (const never of ["Agent", "Skill", "Browser", "TodoWrite"]) expect(boxed).not.toContain(never);
    expect(profileTools("agent", all, { sandboxed: false }).length).toBe(all.length);
  });

  test("the model is offered those tools, a chat prompt, and no permission modes; it is never asked anything", async () => {
    const r = rig((req) => (req.messages.some((m) => m.role === "tool") ? { text: "done" } : { calls: [{ name: "Write", args: { file_path: "notes.md", content: "hi" } }] }), { kind: "chat" });
    expect(r.of("caps")[0]).toMatchObject({ kind: "chat", modes: [] });
    expect(r.of("caps")[0]!.defaultMode).toBeUndefined();
    // Even asking for the strictest mode changes nothing: there is nothing of the person's to protect.
    await r.turn(prompt("make a note", { mode: "ask" }));
    expect(r.of("approval").length).toBe(0);
    expect(readFileSync(join(r.dir, "notes.md"), "utf8")).toBe("hi");
    expect(names(r)).toEqual(["Edit", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "Write"]);
    expect(r.provider.requests[0]!.system).toContain("scratch folder");
    expect(r.provider.requests[0]!.system).not.toContain("coding and operations agent");
    r.cleanup();
  });

  test("a chat keeps no checkpoints and an agent still does", () => {
    const chat = rig(() => ({ text: "x" }), { kind: "chat", checkpoints: { begin: () => undefined } as never });
    expect(chat.of("caps")[0]!.checkpoints).toBeUndefined();
    chat.cleanup();
    const agent = rig(() => ({ text: "x" }), { checkpoints: { begin: () => undefined } as never });
    expect(agent.of("caps")[0]).toMatchObject({ modes: ["ask", "edits", "plan", "auto", "bypass"], checkpoints: true });
    expect(agent.of("caps")[0]!.kind).toBeUndefined();
    agent.cleanup();
  });

  test("a chat cannot read or write outside its folder: not by .., not by an absolute path, not through a link", async () => {
    const outside = mkdtempSync(join(tmpdir(), "navvied-outside-"));
    writeFileSync(join(outside, "secret.txt"), "private");
    const r = rig((req, n, dir) => {
      const step = n === 0 ? { name: "Read", args: { file_path: join(outside, "secret.txt") } }
        : n === 1 ? { name: "Write", args: { file_path: "../escape.txt", content: "x" } }
        : n === 2 ? { name: "Read", args: { file_path: "link/secret.txt" } }
        : n === 3 ? { name: "Glob", args: { pattern: "*", path: outside } }
        : undefined;
      if (n === 0) symlinkSync(outside, join(dir, "link"), "junction"); // a folder link Windows lets anyone make; other systems ignore the type
      return step ? { calls: [step] } : { text: "stopped" };
    }, { kind: "chat" });
    await r.turn(prompt("try it"));
    const results = r.of("tool").filter((e) => e.status !== "running").map((e) => e.output ?? "");
    expect(results.length).toBe(4);
    for (const out of results) expect(out).toContain("outside the folder this conversation may use");
    expect(existsSync(join(r.dir, "..", "escape.txt"))).toBe(false);
    r.cleanup();
  });

  test("an agent still works anywhere it is told to", () => {
    const outside = mkdtempSync(join(tmpdir(), "navvied-outside-"));
    expect(place({ cwd: join(outside, "a") }, "../b.txt")).toBe(join(outside, "b.txt"));
  });

  test("the folder itself, its sub-folders and files that do not exist yet are inside", () => {
    const dir = mkdtempSync(join(tmpdir(), "navvied-chat-"));
    mkdirSync(join(dir, "sub"));
    const ctx = { cwd: dir, root: dir };
    expect(place(ctx, ".")).toBe(dir);
    expect(place(ctx, "sub/new/file.txt")).toBe(join(dir, "sub/new/file.txt"));
    expect(() => place(ctx, "sub/../../x")).toThrow("outside");
  });
});
