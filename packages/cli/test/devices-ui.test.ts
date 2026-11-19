import { describe, expect, test } from "bun:test";
import type { Device } from "../src/devices.ts";
import { deviceRows, when } from "../src/devices-ui.ts";

const DAY = 86_400_000, NOW = 100 * DAY;
const dev = (over: Partial<Device>): Device => ({ id: "a", kind: "site", label: "https://navvied.com", createdAt: NOW - 5 * DAY, ...over });

describe("the list of websites and devices", () => {
  test("times are said in words", () => {
    expect(when(undefined, NOW)).toBe("never");
    expect(when(NOW - 1000, NOW)).toBe("today");
    expect(when(NOW - DAY - 10, NOW)).toBe("yesterday");
    expect(when(NOW - 5 * DAY, NOW)).toBe("5 days ago");
  });
  test("most recently used first, with what each is, when it was allowed and when it was last used; waiting links are not listed", () => {
    const rows = deviceRows([
      dev({ id: "old", label: "https://navvied.com", createdAt: NOW - 20 * DAY, lastUsed: NOW - 5 * DAY }),
      dev({ id: "phone", kind: "relay", label: "Ana's phone", createdAt: NOW - 2 * DAY, lastUsed: NOW }),
      dev({ id: "waiting", kind: "relay", label: "Not yet", pending: true }),
    ], NOW);
    expect(rows.map((r) => r.id)).toEqual(["phone", "old"]);
    expect(rows[0]!.hint).toBe("A phone or another computer. Allowed 2 days ago, last used today.");
    expect(rows[1]!.hint).toBe("A website on this computer's address. Allowed 20 days ago, last used 5 days ago.");
  });
});
