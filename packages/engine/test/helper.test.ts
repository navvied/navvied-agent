import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";
import type { ModelRequest } from "../src/types.ts";

afterAll(cleanupAll, HOOK_MS);

const isMain = (req: ModelRequest): boolean => req.tools.some((t) => t.name === "Agent");
const last = (req: ModelRequest): string => String(req.messages.at(-1)?.content ?? "");

describe("a helper", () => {
  test("researches on its own and hands back only its answer; its steps are shown under the step that asked", async () => {
    const r = rig((req, _n, dir) => {
      if (isMain(req)) return last(req).includes("The notes say") || req.messages.at(-1)?.role === "tool" ? { text: `the helper found: ${last(req)}` } : { calls: [{ name: "Agent", args: { description: "read the notes", prompt: "Read notes.txt and tell me what it says." } }] };
      if (req.messages.at(-1)?.role === "tool") return { text: "The notes say: buy milk." };
      return { calls: [{ name: "Read", args: { file_path: join(dir, "notes.txt") } }] };
    });
    writeFileSync(join(r.dir, "notes.txt"), "buy milk\n");
    await r.turn(prompt("research what my notes say"));
    const events = r.events;
    const ask = events.find((e) => e.ev === "tool" && e.name === "Agent" && e.status === "running" && e.input !== undefined);
    expect(ask).toBeDefined();
    const nested = events.filter((e) => e.ev === "tool" && e.parent !== undefined) as { id: string; parent: string; name: string; status: string }[];
    expect(nested.length).toBeGreaterThan(0);
    const parentId = (ask as { id: string }).id;
    expect(nested.every((e) => e.parent === parentId && e.id.startsWith(`${parentId}.`))).toBe(true);
    expect(nested.some((e) => e.name === "Read" && e.status === "done")).toBe(true);
    expect(r.of("tool").find((e) => e.name === "Agent" && e.status === "done")!.output).toBe("The notes say: buy milk.");
    expect(r.text()).toContain("the helper found: The notes say: buy milk.");
    expect(r.text()).not.toContain("buy milk\n");
    r.cleanup();
  });

  test("the helper starts from nothing but the task, can only read, and cannot ask for another helper", async () => {
    const seen: ModelRequest[] = [];
    const r = rig((req) => {
      if (isMain(req)) return req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Agent", args: { prompt: "Look around." } }] };
      seen.push(req);
      return { text: "looked" };
    });
    await r.turn(prompt("research this: secret context that the helper must not see"));
    expect(seen).toHaveLength(1);
    const helper = seen[0]!;
    expect(JSON.stringify(helper.messages)).toContain("Look around.");
    expect(JSON.stringify(helper.messages)).not.toContain("secret context");
    const names = helper.tools.map((t) => t.name);
    expect(names).toContain("Read");
    for (const forbidden of ["Write", "Edit", "Bash", "KillShell", "Agent"]) expect(names).not.toContain(forbidden);
    r.cleanup();
  });

  test("it is offered to a capable model but not to a small one, and an empty task is refused", async () => {
    const big = rig(() => ({ text: "x" }));
    await big.turn(prompt("hi"));
    expect(big.provider.requests[0]!.tools.map((t) => t.name)).toContain("Agent");
    const small = rig(() => ({ text: "x" }), { window: 8_000, small: true });
    await small.turn(prompt("hi"));
    expect(small.provider.requests[0]!.tools.map((t) => t.name)).not.toContain("Agent");
    const refused = rig((req) => (isMain(req) && req.messages.at(-1)?.role !== "tool" ? { calls: [{ name: "Agent", args: { prompt: "  " } }] } : { text: "ok" }));
    await refused.turn(prompt("go and research it"));
    expect(refused.of("tool").find((e) => e.name === "Agent" && e.status === "error")!.output).toMatch(/^Error: the task is empty/);
    for (const x of [big, small, refused]) x.cleanup();
  });

  test("stopping the turn stops the helper and says so", async () => {
    const r = rig((req) => (isMain(req) ? (req.messages.at(-1)?.role === "tool" ? { text: "stopped" } : { calls: [{ name: "Agent", args: { prompt: "Take your time." } }] }) : { text: "slow", delayMs: 5000 }));
    r.send(prompt("go and research it"));
    await until(() => r.of("tool").some((e) => e.parent !== undefined) || r.provider.requests.length >= 2, 3000);
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.of("done").at(-1)!.stop).toBe("cancelled");
    r.cleanup();
  });

  test("a helper that writes no answer is told so, and one that hits a problem reports it", async () => {
    const quiet = rig((req) => (isMain(req) ? (req.messages.at(-1)?.role === "tool" ? { text: `got: ${last(req)}` } : { calls: [{ name: "Agent", args: { prompt: "x" } }] }) : { text: "" }));
    await quiet.turn(prompt("go and research it"));
    expect(quiet.text()).toContain("The helper wrote no answer.");
    const broken = rig((req) => (isMain(req) ? (req.messages.at(-1)?.role === "tool" ? { text: `got: ${last(req)}` } : { calls: [{ name: "Agent", args: { prompt: "x" } }] }) : { fail: "the model is down" }));
    await broken.turn(prompt("go and research it"));
    expect(broken.text()).toContain("the helper had a problem");
    quiet.cleanup(); broken.cleanup();
  });
});
