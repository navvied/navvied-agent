import { afterAll, describe, expect, test } from "bun:test";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const SECRET = "sk-test-0123456789abcdefghijklmnop";

async function denied(input: string | undefined, opts: Parameters<typeof rig>[1] = {}) {
  const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "understood" } : { calls: [{ name: "Bash", args: { command: "rm -r build" } }] }), opts);
  r.send(prompt("clean up", { mode: "ask" }));
  await until(() => r.of("approval").length === 1);
  r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "deny", ...(input !== undefined ? { input } : {}) });
  await r.engine.idle();
  const step = r.of("tool").filter((e) => e.status === "error").at(-1)!;
  return { r, step };
}

describe("a no that carries the person's own words", () => {
  test("the model is told what the person said, as the result of the step", async () => {
    const { r, step } = await denied("leave build alone, delete only build/tmp");
    expect(step).toMatchObject({ output: "Not run. The person said: leave build alone, delete only build/tmp", outcome: "denied" });
    expect(JSON.stringify(r.provider.requests.at(-1)!.messages)).toContain("Not run. The person said: leave build alone, delete only build/tmp");
    r.cleanup();
  });

  test("a no without words, or with only blanks, says what it said before", async () => {
    for (const input of [undefined, "", "   "]) {
      const { r, step } = await denied(input);
      expect(step).toMatchObject({ output: "The user denied this action.", outcome: "denied" });
      r.cleanup();
    }
  });

  test("a secret the person typed in their words does not reach the model or the screen", async () => {
    const { r, step } = await denied(`use ${SECRET} instead`, { secrets: [SECRET] });
    expect(step.output).toMatch(/^Not run\. The person said: use \[hidden:\d+\] instead$/);
    expect(JSON.stringify(r.provider.requests.at(-1)!.messages)).not.toContain(SECRET);
    r.cleanup();
  });
});
