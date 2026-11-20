import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effort } from "@navvied/protocol";
import { loadConfig } from "../src/config.ts";
import { resolved } from "../src/create.ts";
import { knownEffort } from "../src/presets.ts";
import { hook, removeTree } from "../../protocol/test/support/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-effort-"));
afterAll(hook("known-effort removes what it made", () => removeTree(dir)));

describe("the effort levels of the services that document them", () => {
  test("Claude: five levels on the models of the 5 family and on Opus 4.8 and 4.7, four (no xhigh) on 4.6 and Mythos Preview, three on Opus 4.5, none on models without the setting", () => {
    const five: Effort[] = ["low", "medium", "high", "xhigh", "max"];
    for (const model of ["claude-fable-5-2", "claude-mythos-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-4-7"]) expect(knownEffort({ baseUrl: "https://api.anthropic.com/v1", model }), model).toEqual({ efforts: five });
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview"]) expect(knownEffort({ baseUrl: "https://api.anthropic.com/v1", model }), model).toEqual({ efforts: ["low", "medium", "high", "max"] });
    expect(knownEffort({ baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-4-5-20251101" })).toEqual({ efforts: ["low", "medium", "high"] });
    for (const model of ["claude-3-7-sonnet-20250219", "claude-opus-4-1", "claude-haiku-4-5"]) expect(knownEffort({ baseUrl: "https://api.anthropic.com/v1", model }), model).toBeUndefined();
  });

  test("the same by the person's sign-in, whatever the address; another service that merely uses the messages API is not assumed to take them", () => {
    expect(knownEffort({ model: "claude-opus-5-5", signIn: { provider: "claude" } })?.efforts).toHaveLength(5);
    expect(knownEffort({ baseUrl: "http://127.0.0.1:8080/v1", model: "claude-opus-5-5" })).toBeUndefined();
  });

  test("DeepSeek: low, high and max, as its page says; OpenRouter: its own levels, sent in its reasoning object; OpenAI, local servers and the rest: none listed, so only Auto shows", () => {
    expect(knownEffort({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner" })).toEqual({ efforts: ["low", "high", "max"] });
    expect(knownEffort({ baseUrl: "https://openrouter.ai/api/v1", model: "anything/model" })).toEqual({ efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], field: "reasoning" });
    for (const baseUrl of ["https://api.openai.com/v1", "http://127.0.0.1:11434/v1", "http://localhost:8080/v1", "https://example.org/v1", "not an address", undefined]) expect(knownEffort({ ...(baseUrl ? { baseUrl } : {}), model: "gpt-5" }), String(baseUrl)).toBeUndefined();
  });
});

describe("the model as the program resolves it", () => {
  const load = (models: Record<string, unknown>) => {
    const path = join(dir, `c-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({ default: Object.keys(models)[0], models }));
    const file = loadConfig(path, {});
    if (!file.ok) throw new Error(file.error);
    return { file: file.value, path };
  };

  test("a model with nothing said about effort gets its service's levels; one that lists its own keeps them; one marked reasoning none gets none", () => {
    const { file, path } = load({
      ds: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", apiKey: "k" },
      or: { baseUrl: "https://openrouter.ai/api/v1", model: "x/y", apiKey: "k" },
      own: { baseUrl: "https://api.deepseek.com/v1", model: "m", apiKey: "k", efforts: ["low"] },
      off: { baseUrl: "https://api.deepseek.com/v1", model: "m", apiKey: "k", reasoning: "none" },
      local: { baseUrl: "http://127.0.0.1:8080/v1", model: "m" },
    });
    const get = (name: string) => { const r = resolved(name, file, {}, path); if (!r.ok) throw new Error(r.error); return r.value; };
    expect(get("ds").efforts).toEqual(["low", "high", "max"]);
    expect(get("ds").provider?.effortField).toBeUndefined();
    expect(get("or").efforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(get("or").provider?.effortField).toBe("reasoning");
    expect(get("own").efforts).toEqual(["low"]);
    expect(get("off").efforts).toBeUndefined();
    expect(get("local").efforts).toBeUndefined();
  });
});
