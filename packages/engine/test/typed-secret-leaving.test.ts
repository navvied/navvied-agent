import { afterAll, describe, expect, test } from "bun:test";
import { hideInItems, hideSecrets } from "../src/index.ts";
import { cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll);

const PASSWORD = "Zx9!kQ7mWp2";
const said = `my password is ${PASSWORD}, log in with it`;

describe("what a person typed as a secret does not leave the live engine", () => {
  test("the shared step hides a password said in words, and the same value wherever else it is written", () => {
    expect(hideSecrets(said)).not.toContain(PASSWORD);
    const items = hideInItems([{ k: "user" as const, text: said }, { k: "assistant" as const, text: `I used ${PASSWORD} to log in` }, { k: "tool" as const, text: "Bash" }]);
    expect(JSON.stringify(items)).not.toContain(PASSWORD);
    expect(items[2]!.text).toBe("Bash");
  });

  test("a summary made in compaction does not hold it, even when the model repeats it", async () => {
    const r = rig((req) => ({ text: `ok ${req.messages.length}` }));
    r.provider.complete = async () => `The person gave the password ${PASSWORD} and asked to log in.`;
    for (const text of [said, "and then?", "and then?", "and then?"]) await r.turn(prompt(text));
    await r.turn({ cmd: "compact" });
    await r.turn(prompt("what now?"));
    const last = r.provider.requests.at(-1)!.messages;
    const summary = JSON.stringify(last.find((m) => typeof m.content === "string" && m.content.startsWith("[Summary of the earlier conversation]")));
    expect(summary).toContain("Summary of the earlier conversation");
    expect(summary).not.toContain(PASSWORD);
    r.cleanup();
  });
});
