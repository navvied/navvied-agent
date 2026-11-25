import { afterAll, describe, expect, test } from "bun:test";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(async () => { await cleanupAll(); });

describe("a tool the person switched off", () => {
  test("is not offered, is not named as available, and a call to it is refused by name", async () => {
    const on = new Set<string>();
    const r = rig((req, n) => (n === 0 ? { calls: [{ name: "Glob", args: { pattern: "*" } }] } : { text: "done" }), { toolOn: (name) => name !== "Glob" && !on.has(name) });
    await r.turn(prompt("list the files here"));
    const first = r.provider.requests[0]!;
    expect(first.tools.map((t) => t.name)).not.toContain("Glob");
    expect(first.tools.map((t) => t.name)).toContain("Read");
    expect(first.system).not.toMatch(/by name:[^.]*\bGlob\b/);
    const result = r.provider.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(result)).toContain("the tool Glob is turned off by the person");
    r.cleanup();
  });

  test("switching it off takes effect at once, in the conversation that is open, and switching it on brings it back", async () => {
    let off = false;
    const r = rig(() => ({ text: "ok" }), { toolOn: (name) => !(off && name === "Grep") });
    await r.turn(prompt("one"));
    expect(r.provider.requests.at(-1)!.tools.map((t) => t.name)).toContain("Grep");
    off = true;
    await r.turn(prompt("two"));
    expect(r.provider.requests.at(-1)!.tools.map((t) => t.name)).not.toContain("Grep");
    off = false;
    await r.turn(prompt("three"));
    expect(r.provider.requests.at(-1)!.tools.map((t) => t.name)).toContain("Grep");
    r.cleanup();
  });

  test("with no switch given, every tool is as it was", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("one"));
    const names = r.provider.requests[0]!.tools.map((t) => t.name);
    for (const n of ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]) expect(names).toContain(n);
    r.cleanup();
  });
});
