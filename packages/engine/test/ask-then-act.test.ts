import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig, until } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const ANSWERED = "[The person answered. Do it.]";
const NOBODY = "[Nobody can answer. Pick the most reasonable option, say what you assumed, and do it.]";
const results = (req: ModelRequest): number => req.messages.filter((m) => m.role === "tool").length;
const nudges = (req: ModelRequest): string[] => req.messages.filter((m) => m.role === "user" && (m.content === ANSWERED || m.content === NOBODY)).map((m) => String(m.content));
const ask = { name: "AskUserQuestion", args: { questions: [{ question: "Which port?" }] } };

/** The model of the failure: it asks, hears the answer, and ends with an offer to do what it was asked. */
const offers = (dir: string, nudged: string) => (req: ModelRequest) => {
  const n = results(req);
  if (n === 0) return { calls: [ask] };
  if (!nudges(req).includes(nudged)) return { text: "I have not made the file. If you want, I can make config.json." };
  if (n === 1) return { calls: [{ name: "Write", args: { file_path: join(dir, "config.json"), content: '{"port": 7431}\n' } }] };
  return { text: "Made it." };
};

describe("the model asked, and then did not act", () => {
  test("an answered question followed by an offer is told once to do it, and it does", async () => {
    const r = rig((req, _n, dir) => offers(dir, ANSWERED)(req), { attended: () => true });
    r.send(prompt("the service needs a config.json with its port"));
    await until(() => r.of("question").length === 1);
    r.send({ cmd: "answer", id: r.of("question")[0]!.id, answers: [["7431"]] });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "config.json"))).toBe(true);
    expect(nudges(r.provider.requests.at(-1)!)).toEqual([ANSWERED]);
    r.cleanup();
  });

  test("when nobody could be asked, the question tool says to pick and go on, and an offer is told once to do it", async () => {
    const r = rig((req, _n, dir) => offers(dir, NOBODY)(req));
    await r.turn(prompt("the service needs a config.json with its port"));
    const told = String(r.provider.requests[1]!.messages.at(-1)!.content);
    expect(told).toBe("Nobody can answer now: pick the most reasonable option, say what you assumed, and do the work.");
    expect(existsSync(join(r.dir, "config.json"))).toBe(true);
    expect(nudges(r.provider.requests.at(-1)!)).toEqual([NOBODY]);
    r.cleanup();
  });

  test("a model that offers again after the note is let go: one note, no loop", async () => {
    const r = rig((req) => (results(req) === 0 ? { calls: [ask] } : { text: "If you want, I can do it." }));
    await r.turn(prompt("go"));
    expect(r.provider.requests).toHaveLength(3);
    expect(nudges(r.provider.requests.at(-1)!)).toEqual([NOBODY]);
    r.cleanup();
  });

  test("a model that acts after the answer is not told anything", async () => {
    const r = rig((req, _n, dir) => {
      const n = results(req);
      if (n === 0) return { calls: [ask] };
      if (n === 1) return { calls: [{ name: "Write", args: { file_path: join(dir, "config.json"), content: "{}\n" } }] };
      return { text: "done" };
    });
    await r.turn(prompt("go"));
    expect(nudges(r.provider.requests.at(-1)!)).toEqual([]);
    expect(r.provider.requests).toHaveLength(3);
    r.cleanup();
  });

  test("no question, plan mode: nothing is added", async () => {
    const plain = rig(() => ({ text: "here is the answer" }));
    await plain.turn(prompt("what is a port?"));
    expect(plain.provider.requests).toHaveLength(1);
    plain.cleanup();
    const planning = rig((req) => (results(req) === 0 ? { calls: [ask] } : { text: "the plan" }));
    await planning.turn(prompt("plan it", { mode: "plan" }));
    expect(nudges(planning.provider.requests.at(-1)!)).toEqual([]);
    planning.cleanup();
  });
});
