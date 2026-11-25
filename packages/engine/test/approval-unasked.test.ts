import { afterAll, describe, expect, test } from "bun:test";
import { cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll);

const outputOf = (r: ReturnType<typeof rig>): string => (r.events.filter((e) => e.ev === "tool" && e.status !== "running").at(-1) as { output?: string }).output ?? "";
const script = (req: { messages: { role: string }[] }) => (req.messages[req.messages.length - 1]?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: "echo hi > out.txt" } }] });

describe("a refusal says whether anyone was asked", () => {
  test("a person who said no: the plain denial", async () => {
    const r = rig(script);
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny" });
    await r.engine.idle();
    expect(outputOf(r)).toBe("The user denied this action.");
    r.cleanup();
  });

  test("a host that refused for itself: nobody could be asked", async () => {
    const r = rig(script);
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny", unasked: true });
    await r.engine.idle();
    expect(outputOf(r)).toContain("nobody could be asked");
    r.cleanup();
  });
});
