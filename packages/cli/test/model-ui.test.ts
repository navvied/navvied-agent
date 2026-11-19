import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@navvied/protocol";
import type { ConfigFile } from "../src/config.ts";
import { effortLabel, effortRows, modelRows } from "../src/model-ui.ts";

type Caps = Extract<EngineEvent, { ev: "caps" }>;
const caps = (extra: Partial<Caps> = {}): Caps => ({ ev: "caps", steer: true, modes: ["auto"], compact: true, ...extra });
const file: ConfigFile = { models: {
  raphael: { baseUrl: "https://hosted.example/v1", model: "raphael" },
  local: { baseUrl: "http://127.0.0.1:11434", api: "ollama", model: "qwen2.5:3b" },
  prog1: { command: "prog" },
  prog2: { command: "other" },
} };

describe("the list of models", () => {
  test("the models of this conversation come first with the one in use marked, then the other programs, then a way to add one", () => {
    const rows = modelRows(caps({ models: [{ id: "raphael", name: "raphael", current: true }, { id: "local", name: "qwen2.5:3b", blurb: "On this computer." }] }), "raphael", file);
    expect(rows.map((r) => [r.label, r.hint, r.action])).toEqual([
      ["raphael", "In use now.", { kind: "current" }],
      ["qwen2.5:3b", "On this computer.", { kind: "switch", id: "local" }],
      ["prog1", "Through a program you are signed in to. Starts a new conversation.", { kind: "restart", name: "prog1" }],
      ["prog2", "Through a program you are signed in to. Starts a new conversation.", { kind: "restart", name: "prog2" }],
      ["Connect another model", "Sign in to a service, or add one on this computer.", { kind: "connect" }],
    ]);
  });
  test("with nothing to switch inside, the model in use is listed alone with the others", () => {
    const rows = modelRows(undefined, "raphael", { models: { raphael: file.models.raphael!, local: file.models.local! } });
    expect(rows.map((r) => r.label)).toEqual(["raphael", "qwen2.5:3b", "Connect another model"]);
    expect(rows[0]!.action).toEqual({ kind: "current" });
    expect(rows[1]!.action).toEqual({ kind: "restart", name: "local" });
  });
  test("a model that is locked says so and can still be seen", () => {
    const rows = modelRows(caps({ models: [{ id: "a", name: "A", current: true }, { id: "b", name: "B", locked: true }] }), "a", null);
    expect(rows[1]!.hint).toBe("Not available yet.");
  });
  test("only a connect row when nothing is configured", () => {
    expect(modelRows(undefined, "x", null).map((r) => r.label)).toEqual(["x", "Connect another model"]);
  });
});

describe("the effort levels", () => {
  test("Auto comes first, then each level the model has, in words", () => {
    expect(effortRows(["low", "high", "xhigh"]).map((r) => [r.level, r.label])).toEqual([["auto", "Auto"], ["low", "Low"], ["high", "High"], ["xhigh", "Very high"]]);
    expect(effortLabel("max")).toBe("Maximum");
  });
});
