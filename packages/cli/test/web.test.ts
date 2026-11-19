import { afterAll, describe, expect, test } from "bun:test";
import { main } from "../src/main.ts";
import { askToPair, connectLink } from "../src/commands/web.ts";
import { fakeIO, fakeSystem, remove, startMockModel, tempDir, until } from "./helpers.ts";

const mock = startMockModel();
const dirs: string[] = [];
afterAll(() => { mock.stop(); dirs.forEach(remove); });

const env = () => {
  const state = tempDir();
  dirs.push(state);
  return { HOME: state, XDG_STATE_HOME: state, NAVVIED_BASE_URL: mock.url, NAVVIED_MODEL: "mock-model", NAVVIED_WINDOW: "100000" };
};

describe("navvied web", () => {
  test("starts the engine, opens the page with the address and key after the #, and stops on Ctrl+C", async () => {
    const system = fakeSystem();
    const f = fakeIO({ env: env(), system });
    const running = main(["web", "--port", "0", "--site", "https://beta.example"], f.io);
    await until(() => system.opened.length > 0);
    const link = new URL(system.opened[0]!);
    expect(link.origin).toBe("https://beta.example");
    expect(link.search).toBe("");
    const params = new URLSearchParams(link.hash.slice(1));
    expect(params.get("connect")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(params.get("key")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const info = await fetch(`${params.get("connect")}/api/info`, { headers: { authorization: `Bearer ${params.get("key")}` } });
    expect(info.status).toBe(200);
    expect(f.err()).toContain("navvied is running on this computer");
    expect(f.err()).toContain("It will ask you here");
    f.interrupt();
    expect(await running).toBe(0);
    await expect(fetch(`${params.get("connect")}/api/info`)).rejects.toThrow();
  });
  test("refuses a site that is not a plain web address", async () => {
    const f = fakeIO({ env: env() });
    expect(await main(["web", "--site", "javascript:alert(1)"], f.io)).toBe(2);
    expect(f.err()).toContain("--site must be a web address");
  });
  test("the link keeps the address safe inside the fragment", () => {
    const link = connectLink("https://navvied.com/", "http://127.0.0.1:8787", "KEY");
    expect(link).toBe("https://navvied.com/#connect=http%3A%2F%2F127.0.0.1%3A8787&key=KEY");
  });
});

describe("the question about a website", () => {
  const ask = (answer: number | "back" | undefined | "none") => {
    const shown: unknown[] = [];
    const io = { ...fakeIO({ interactive: true }).io, ...(answer === "none" ? {} : { choose: async (...a: unknown[]) => { shown.push(a); return answer as number; } }) };
    return { io, shown };
  };
  test("offers this time, remember, and no, and shows the origin and the code", async () => {
    const { io, shown } = ask(0);
    expect(await askToPair(io, { origin: "https://beta.example", code: "K7QM-4TXD" })).toBe("once");
    const [title, items, , frame] = shown[0] as [string, { label: string }[], number, { heading: string[]; notice: string[] }];
    expect(title).toBe("Allow this website?");
    expect(items.map((i) => i.label)).toEqual(["Yes, this time", "Yes, and remember this website", "No"]);
    expect(frame.heading.join(" ")).toContain("https://beta.example");
    expect(frame.notice.join(" ")).toContain("K7QM-4TXD");
  });
  test("remember, no, escape and 'back' map as expected; with no menu available the answer is no", async () => {
    expect(await askToPair(ask(1).io, { origin: "o", code: "c" })).toBe("always");
    expect(await askToPair(ask(2).io, { origin: "o", code: "c" })).toBe("no");
    expect(await askToPair(ask(undefined).io, { origin: "o", code: "c" })).toBe("no");
    expect(await askToPair(ask("back").io, { origin: "o", code: "c" })).toBe("no");
    expect(await askToPair(ask("none").io, { origin: "o", code: "c" })).toBe("no");
  });
});
