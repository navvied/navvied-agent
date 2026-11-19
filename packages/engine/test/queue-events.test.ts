import { afterAll, describe, expect, test } from "bun:test";
import { cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll);

/** A turn that takes a second (a command that sleeps), so there is time to send more while it runs. */
const busy = (req: { messages: { role: string }[] }) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "an answer" } : { calls: [{ name: "Bash", args: { command: "sleep 1" } }] });

describe("a message that waits its turn is told to every window", () => {
  test("it is announced as queued when the agent is busy, and then taken as usual; the first message is not queued", async () => {
    const r = rig(busy);
    r.send(prompt("start", { qid: "a" }));
    await until(() => r.of("taken").length === 1);
    r.send(prompt("a second thought", { qid: "b" }));
    await r.engine.idle();
    const queued = r.of("queued");
    expect(queued).toEqual([{ ev: "queued", qid: "b", text: "a second thought" }]);
    expect(r.of("taken").map((e) => e.qid)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(r.of("dropped")).toHaveLength(0);
    r.cleanup();
  });

  test("stopping the agent takes the waiting messages off every screen", async () => {
    const r = rig(busy);
    r.send(prompt("start", { qid: "a" }));
    await until(() => r.of("taken").length === 1);
    r.send(prompt("one more", { qid: "b" }));
    r.send(prompt("and another", { qid: "c" }));
    r.send({ cmd: "cancel" });
    await r.engine.idle();
    expect(r.of("dropped")).toEqual([{ ev: "dropped", qids: ["b", "c"] }]);
    // They were never taken.
    expect(r.of("taken").map((e) => e.qid)).not.toContain("c");
    r.cleanup();
  });
});
