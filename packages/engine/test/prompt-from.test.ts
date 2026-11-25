import { afterAll, describe, expect, test } from "bun:test";
import { validateCommand } from "@navvied/protocol";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("who a turn came from", () => {
  test("the user event of a message from another agent says who, and one from the person says nothing", async () => {
    const r = rig(() => ({ text: "ok" }));
    await r.turn(prompt("asked by an agent", { qid: "q1", from: { agent: "Docs helper", name: "docs" } }));
    await r.turn(prompt("asked by the person", { qid: "q2" }));
    const users = r.of("user");
    expect(users[0]).toMatchObject({ qid: "q1", from: { agent: "Docs helper", name: "docs" } });
    expect("from" in users[1]!).toBe(false);
    r.cleanup();
  });

  test("a message that waits for its turn says who as well", async () => {
    const r = rig((_q, n) => (n === 0 ? { calls: [{ name: "Bash", args: { command: "sleep 0.3" } }] } : { text: "ok" }));
    r.send(prompt("first", { qid: "a" }));
    r.send(prompt("second", { qid: "b", from: { agent: "x", name: "docs" } }));
    await r.engine.idle();
    expect(r.of("queued")[0]).toMatchObject({ qid: "b", from: { agent: "x", name: "docs" } });
    expect(r.of("user").find((u) => u.qid === "b")).toMatchObject({ from: { agent: "x", name: "docs" } });
    r.cleanup();
  });

  test("a command read from a window cannot claim to be another agent", () => {
    const v = validateCommand({ cmd: "prompt", text: "hi", from: { agent: "boss", name: "boss" } });
    expect(v.ok && "from" in v.value).toBe(false);
  });
});
