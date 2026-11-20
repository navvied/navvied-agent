import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFUSED, type ModelInfo } from "@navvied/protocol";
import type { ModelSwitch } from "../src/index.ts";
import { HOOK_MS, ScriptedProvider, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);

const attachments = mkdtempSync(join(tmpdir(), "navvied-files-closed-"));
const file = { name: "n.txt", mime: "text/plain", data: Buffer.from("hello").toString("base64") };
const MODELS: ModelInfo[] = [{ id: "open", name: "Open" }, { id: "closed", name: "Closed", files: false }, { id: "yes", name: "Yes", files: true }];

function engineOn(current: string) {
  const provider = new ScriptedProvider(() => ({ text: "ok" }));
  const switcher: ModelSwitch = { models: MODELS, current, use: () => ({ provider, window: 100_000 }) };
  const r = rig(() => ({ text: "ok" }), { switcher, attachments });
  return Object.assign(r, { second: provider });
}

describe("a model that is closed to files (caps.models[].files false)", () => {
  test("a file sent to it is refused with the one sentence, not saved, not told to the model as content, and the person is told once", async () => {
    const r = engineOn("closed");
    expect(r.of("caps").at(-1)!.models!.find((m) => m.id === "closed")).toEqual({ id: "closed", name: "Closed", files: false, current: true });
    await r.turn(prompt("see this", { qid: "q", files: [file] }));
    expect(r.of("user")[0]).toEqual({ ev: "user", qid: "q", text: "see this", files: [{ name: "n.txt", kind: "refused", note: REFUSED.noFiles }] });
    expect(r.of("notice").map((e) => e.msg)).toEqual(["This model does not take files here."]);
    const told = JSON.stringify(r.provider.requests.at(-1)!.messages);
    expect(told).toContain("not attached: n.txt. This model does not take files here.");
    expect(told).not.toContain("hello");
    expect(existsSync(join(attachments, r.engine.sessionId))).toBe(false);
    r.cleanup();
  });

  test("a model that says nothing, or says yes, takes files as before", async () => {
    for (const id of ["open", "yes"]) {
      const r = engineOn(id);
      await r.turn(prompt("see this", { qid: "q", files: [file] }));
      expect(r.of("user")[0]!.files).toEqual([{ name: "n.txt", kind: "text" }]);
      expect(r.of("notice")).toEqual([]);
      r.cleanup();
    }
  });

  test("the model chosen for the next message decides, and pictures in `images` are not files", async () => {
    const r = engineOn("open");
    r.send({ cmd: "model", id: "closed" });
    await r.engine.idle();
    await r.turn(prompt("see this", { qid: "q", files: [file] }));
    expect(r.of("user")[0]!.files![0]!.kind).toBe("refused");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
    await r.turn(prompt("a picture", { qid: "q2", images: [{ mime: "image/png", data: png }] }));
    expect(JSON.stringify(r.second.requests.at(-1)!.messages)).toContain('"type":"image"');
    r.cleanup();
  });

  test("an engine with one model reads it from its own description", async () => {
    const r = rig(() => ({ text: "ok" }), { attachments, model: { id: "m", name: "M", files: false } });
    await r.turn(prompt("see this", { qid: "q", files: [file] }));
    expect(r.of("user")[0]!.files![0]!.note).toBe(REFUSED.noFiles);
    r.cleanup();
  });
});
