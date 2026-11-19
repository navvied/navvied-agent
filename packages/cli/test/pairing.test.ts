import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../src/devices.ts";
import { createPairing, newCode, type Decision } from "../src/pairing.ts";

const dirs: string[] = [];
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-pair-")); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SITE = "https://navvied.com";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function rig(answer: Decision | (() => Promise<Decision>), extra: { now?: () => number; waitMs?: number } = {}) {
  const path = join(temp(), "devices.json");
  const store = new DeviceStore(path);
  const asked: { origin: string; code: string }[] = [];
  const pairing = createPairing({ store, allowed: new Set([SITE]), ask: async (q) => { asked.push(q); return typeof answer === "function" ? answer() : answer; }, ...extra });
  return { pairing, store, path, asked };
}

describe("codes", () => {
  test("eight characters in two groups, without the letters people mix up", () => {
    for (let i = 0; i < 200; i++) expect(newCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });
});

describe("a website asking to use this engine", () => {
  test("is shown to the person with the same code the page gets, and on 'yes, remember' gets a key once", async () => {
    const r = rig("always");
    const first = r.pairing.request(SITE);
    if (!first.ok) throw new Error("refused");
    expect(first.expiresIn).toBe(120);
    await tick();
    expect(r.asked).toEqual([{ origin: SITE, code: first.code }]);
    const got = r.pairing.poll(first.id, SITE)!;
    expect(got.state).toBe("allowed");
    expect(got.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.pairing.accepts(got.key!)).toBe(true);
    expect(r.pairing.poll(first.id, SITE)).toEqual({ state: "allowed" });
  });
  test("'yes, this time' works now but is forgotten with the program; 'always' survives a restart without storing the key", async () => {
    const a = rig("once");
    const one = a.pairing.request(SITE);
    if (!one.ok) throw new Error("refused");
    await tick();
    const keyOnce = a.pairing.poll(one.id, SITE)!.key!;
    expect(a.pairing.accepts(keyOnce)).toBe(true);
    expect(a.store.list()).toHaveLength(0);
    expect(rig("once").pairing.accepts(keyOnce)).toBe(false);

    const b = rig("always");
    const two = b.pairing.request(SITE);
    if (!two.ok) throw new Error("refused");
    await tick();
    const key = b.pairing.poll(two.id, SITE)!.key!;
    const again = createPairing({ store: new DeviceStore(b.path), allowed: new Set([SITE]), ask: async () => "no" });
    expect(again.accepts(key)).toBe(true);
    expect(readFileSync(b.path, "utf8")).not.toContain(key);
    if (process.platform !== "win32") expect(statSync(b.path).mode & 0o777).toBe(0o600);
  });
  test("'no' gives no key", async () => {
    const r = rig("no");
    const q = r.pairing.request(SITE);
    if (!q.ok) throw new Error("refused");
    await tick();
    expect(r.pairing.poll(q.id, SITE)).toEqual({ state: "denied" });
  });
  test("a website that is not served, or that sends no origin, is refused and the person is never asked", async () => {
    const r = rig("always");
    expect(r.pairing.request("https://evil.example")).toEqual({ ok: false, status: 403 });
    expect(r.pairing.request(null)).toEqual({ ok: false, status: 403 });
    await tick();
    expect(r.asked).toHaveLength(0);
  });
  test("only the website that asked can read the answer, and an unknown request gives nothing", async () => {
    const r = rig("always");
    const q = r.pairing.request(SITE);
    if (!q.ok) throw new Error("refused");
    await tick();
    expect(r.pairing.poll(q.id, "https://evil.example")).toBeUndefined();
    expect(r.pairing.poll(q.id, null)).toBeUndefined();
    expect(r.pairing.poll("nope", SITE)).toBeUndefined();
  });
  test("a request nobody answers expires", async () => {
    let now = 0;
    const r = rig(() => new Promise<Decision>(() => {}), { now: () => now, waitMs: 1000 });
    const q = r.pairing.request(SITE);
    if (!q.ok) throw new Error("refused");
    expect(r.pairing.poll(q.id, SITE)).toEqual({ state: "waiting" });
    now = 2000;
    expect(r.pairing.poll(q.id, SITE)).toEqual({ state: "expired" });
  });
  test("one question at a time: a second request while one is open is turned away, so nobody can flood the terminal", async () => {
    const r = rig(() => new Promise<Decision>(() => {}));
    expect(r.pairing.request(SITE).ok).toBe(true);
    expect(r.pairing.request(SITE)).toEqual({ ok: false, status: 429 });
  });
  test("asking again and again is limited", async () => {
    const r = rig("no");
    let refused = 0;
    for (let i = 0; i < 12; i++) { const q = r.pairing.request(SITE); await tick(); if (!q.ok) refused++; }
    expect(refused).toBeGreaterThan(0);
  });
  test("a key nobody was given is not accepted", () => {
    expect(rig("always").pairing.accepts("x".repeat(43))).toBe(false);
  });
});

describe("the device list", () => {
  test("is kept, can lose a device, and survives a damaged file", () => {
    const path = join(temp(), "d", "devices.json");
    const store = new DeviceStore(path);
    store.add({ id: "a", kind: "site", label: SITE, keyHash: "h", createdAt: 1 });
    store.add({ id: "b", kind: "relay", label: "Ana's phone", secret: "s", createdAt: 2 });
    expect(new DeviceStore(path).list().map((d) => d.id)).toEqual(["a", "b"]);
    expect(store.remove("a")).toBe(true);
    expect(store.remove("a")).toBe(false);
    expect(new DeviceStore(path).list().map((d) => d.id)).toEqual(["b"]);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    rmSync(path);
    expect(new DeviceStore(path).list()).toEqual([]);
  });
});
