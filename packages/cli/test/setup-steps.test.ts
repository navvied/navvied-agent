import { describe, expect, test } from "bun:test";
import { stepsOf } from "../src/setup-steps.ts";

const items = [{ name: "runtime.tar.gz", size: 100 }, { name: "model.gguf", size: 300 }, { name: "mmproj.gguf", size: 100 }];

describe("the steps of a setup", () => {
  test("before the answer every step waits and the whole is at 0", () => {
    expect(stepsOf(items, { at: "ask" })).toEqual({ percent: 0, steps: items.map((i) => ({ name: i.name, state: "waiting", bytes: 0, total: i.size })) });
  });

  test("the file being worked on is active with its own bytes, the ones before it are done and the ones after wait", () => {
    const got = stepsOf(items, { at: "work", file: "model.gguf", bytes: 150 });
    expect(got.percent).toBe(30);
    expect(got.steps).toEqual([
      { name: "runtime.tar.gz", state: "done", bytes: 100, total: 100 },
      { name: "model.gguf", state: "active", bytes: 50, total: 300 },
      { name: "mmproj.gguf", state: "waiting", bytes: 0, total: 100 },
    ]);
  });

  test("a file the list does not name is found by the bytes", () => {
    expect(stepsOf(items, { at: "work", file: "runtime", bytes: 420 }).steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
    expect(stepsOf(items, { at: "work", bytes: 500 }).steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
  });

  test("a failure marks the step it stopped at; a stop puts that step back to waiting; done finishes all", () => {
    expect(stepsOf(items, { at: "failed", file: "model.gguf", bytes: 150 }).steps.map((s) => s.state)).toEqual(["done", "failed", "waiting"]);
    expect(stepsOf(items, { at: "paused", file: "model.gguf", bytes: 150 }).steps.map((s) => s.state)).toEqual(["done", "waiting", "waiting"]);
    expect(stepsOf(items, { at: "done" })).toMatchObject({ percent: 100 });
  });

  test("nothing to fetch is no steps", () => {
    expect(stepsOf([], { at: "work", bytes: 0 })).toEqual({ steps: [], percent: 0 });
  });
});
