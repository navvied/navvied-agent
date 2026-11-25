import { describe, expect, test } from "bun:test";
import { toolsScreen } from "../src/tools-screen.ts";
import { computer, scripted } from "./providers-helpers.ts";

const no = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
const report = async (c: ReturnType<typeof computer>) => { const e = await c.link.call("tools", { cmd: "tools" }); if (typeof e === "string") throw new Error(e); return e; };

describe("/tools against a real hub", () => {
  test("Memory is switched off on its own: the hub keeps it, Session Search stays on, and the list shows it", async () => {
    const c = computer(no);
    const t = scripted(["Memory & knowledge", 0, undefined, undefined]);
    await toolsScreen(t.kit(c.link));
    const entries = (await report(c)).entries;
    expect(entries.find((e) => e.id === "memory")!.on).toBe(false);
    expect(entries.find((e) => e.id === "session-search")!.on).toBe(true);
    expect(t.shown[2]!.items.map((i) => i.label.slice(0, 3))).toEqual(["off", "on ", "on "]);
  });
  test("files and search are one switch through the hub; the media with nothing set up are listed as needing it", async () => {
    const c = computer(no);
    const t = scripted(["Work", 0, "Turn it off", undefined, "See, hear & create", undefined, undefined]);
    await toolsScreen(t.kit(c.link));
    const entries = (await report(c)).entries;
    expect(entries.find((e) => e.id === "files")!.on).toBe(false);
    expect(entries.find((e) => e.id === "terminal")!.on).toBe(true);
    expect(t.shown.find((s) => s.title === "See, hear & create")!.items.every((i) => i.label.endsWith("Needs setup"))).toBe(true);
  });
  test("Code Execution is listed as experimental and off, and one press switches it on", async () => {
    const c = computer(no);
    const t = scripted(["Work", 2, undefined, undefined]);
    await toolsScreen(t.kit(c.link));
    const row = t.shown.find((s) => s.title === "Work")!.items[2]!;
    expect(row.label).toBe("off  Code Execution  Experimental");
    expect((await report(c)).entries.find((e) => e.id === "code")!.on).toBe(true);
  });
});
