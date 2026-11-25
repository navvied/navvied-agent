import { afterAll, describe, expect, test } from "bun:test";
import { askLines } from "../src/tools/computer-ask.ts";
import type { ComputerCall, ComputerConsent, ComputerHelper, ComputerResult } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

/** A helper that asks before it types, as the host of a screen does. */
class Asking implements ComputerHelper {
  answers: string[] = [];
  async call(c: ComputerCall, _s?: AbortSignal, consent?: ComputerConsent): Promise<ComputerResult> {
    if (c.action === "type" && c.app) {
      const a = consent ? await consent({ app: c.app, about: "input" }) : "no";
      this.answers.push(a);
      if (a === "no") return { verdict: "refused", code: "blocked_by_policy", app: c.app };
    }
    return { verdict: "delivered", app: c.app ?? "Notes", tree: '1 text field "Body"' };
  }
}

const script = (...steps: { name: string; args: unknown }[]) => (_r: unknown, n: number) => (n < steps.length ? { calls: [steps[n]!] } : { text: "done" });

describe("consent to use an application", () => {
  test("the lines of a step are the action as written, and for typing the text, a line each, at most 8 of at most 200 characters", () => {
    expect(askLines({ action: "capture", app: "Notes", mode: "ax" })).toEqual(["capture Notes (ax)"]);
    expect(askLines({ action: "click", target: 12 })).toEqual(["click 12"]);
    expect(askLines({ action: "click", x: 5, y: 6, button: "right", keys: "shift" })).toEqual(["right click at 5,6 holding shift"]);
    expect(askLines({ action: "key", keys: "cmd+s" })).toEqual(["key cmd+s"]);
    expect(askLines({ action: "drag", target: 2, to: 3 })).toEqual(["drag 2 to 3"]);
    expect(askLines({ action: "type", text: "Hello\nthere" })).toEqual(["type", "Hello", "there"]);
    const long = askLines({ action: "type", text: Array.from({ length: 20 }, () => "x".repeat(300)).join("\n") });
    expect(long).toHaveLength(8);
    expect(long[1]!.length).toBe(200);
  });

  test("an approval with the application and the lines goes to the window; Allow once, Allow for the application and Deny come back as once, app and no", async () => {
    for (const [option, want] of [["allow", "once"], ["allow_always", "app"], ["deny", "no"]] as const) {
      const helper = new Asking();
      const r = rig(script({ name: "computer", args: { action: "type", app: "Notes", text: "Hello" } }), { computer: helper });
      const turn = r.turn(prompt("type hello"));
      await until(() => r.of("approval").length > 0);
      const card = r.of("approval")[0]!;
      expect(card.screen).toEqual({ app: "Notes", about: "input", lines: ["type", "Hello"] });
      expect(card.tool).toBe(r.of("tool")[0]!.id);
      expect(card.options.map((o) => o.optionId)).toEqual(["allow", "allow_always", "deny"]);
      r.send({ cmd: "approve", id: card.id, optionId: option });
      await turn;
      expect(helper.answers).toEqual([want]);
      r.cleanup();
    }
  });

  test("a secret in the typed text is hidden in the lines", async () => {
    const helper = new Asking();
    const r = rig(script({ name: "computer", args: { action: "type", app: "Notes", text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } }), { computer: helper });
    const turn = r.turn(prompt("type"));
    await until(() => r.of("approval").length > 0);
    const card = r.of("approval")[0]!;
    expect(JSON.stringify(card.screen)).not.toContain("sk-ant-api03");
    r.send({ cmd: "approve", id: card.id, optionId: "deny" });
    await turn;
    r.cleanup();
  });
});
