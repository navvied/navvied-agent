import { expect, test } from "bun:test";
import { findNumber, firstNumber } from "../src/computer-use/find.ts";

test("a number is found next to a string that holds the name, wherever the answer keeps it", () => {
  const apps = { apps: [{ name: "Finder", pid: 10 }, { info: { title: "navvied-target" }, pid: 42, other: 1 }] };
  expect(findNumber(apps, "pid", "NAVVIED-target")).toBe(42);
  expect(findNumber(apps, "pid", "missing")).toBeUndefined();
  expect(findNumber([{ name: "x", pid: "7" }], "pid", "x")).toBeUndefined();
});

test("the first number under a key is taken from nested answers", () => {
  expect(firstNumber({ windows: [{ layer: 0, window_id: 7 }, { window_id: 9 }] }, "window_id")).toBe(7);
  expect(firstNumber({ a: 1 }, "window_id")).toBeUndefined();
});
