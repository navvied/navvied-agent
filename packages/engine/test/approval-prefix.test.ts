import { afterAll, describe, expect, test } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

describe("a permission given for a command covers its prefix, part by part", () => {

  test("agreeing to `echo one` for the session covers `echo two`, not `echo one && printf x`, and the question names every part", async () => {
    let command = "echo one";
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command } }] }));
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    expect(r.of("approval")[0]!.options[1]!.name).toBe("Allow, and do not ask again for echo commands");
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    command = "echo two";
    r.send(prompt("again", { mode: "ask" }));
    await r.engine.idle();
    expect(r.of("approval")).toHaveLength(1);
    command = "echo one && printf x";
    r.send(prompt("compound", { mode: "ask" }));
    await until(() => r.of("approval").length === 2);
    expect(r.of("approval")[1]!.options[1]!.name).toBe("Allow, and do not ask again for echo and printf commands");
    r.send({ cmd: "approve", id: r.of("approval")[1]!.id, optionId: "deny" });
    await r.engine.idle();
    r.cleanup();
  });

  test("agreeing to `git add` does not agree to `git push`, and a subshell hides nothing", async () => {
    let command = "git add x";
    const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command } }] }));
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "allow_always" });
    await r.engine.idle();
    for (const [i, next] of ["git push origin main", "git add x && echo $(git push)"].entries()) {
      command = next;
      r.send(prompt("next", { mode: "ask" }));
      await until(() => r.of("approval").length === i + 2);
      r.send({ cmd: "approve", id: r.of("approval")[i + 1]!.id, optionId: "deny" });
      await r.engine.idle();
    }
    r.cleanup();
  });
});
