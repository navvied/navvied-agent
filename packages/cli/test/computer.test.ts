import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerName, connectThisComputer, disconnectThisComputer, relayUrlFor } from "../src/computer.ts";
import { DeviceStore } from "../src/devices.ts";

const account = { server: "https://navvied.test", token: "nv_t", email: "you@example.com" };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const store = () => new DeviceStore(join(mkdtempSync(join(tmpdir(), "computer-")), "devices.json"));

describe("this computer as one of the account's computers", () => {
  test("a Mac is called what its owner named it; a network name that is only an address is never used", () => {
    expect(computerName("darwin", () => "Naweed's MacBook\n")).toBe("Naweed's MacBook");
    expect(computerName("linux", () => "")).not.toMatch(/^\d+(\.\d+){3}$/);
    expect(computerName("darwin", () => "")).toBeTruthy();
  });
  test("the relay address is the account's own site", () => {
    expect(relayUrlFor("https://navvied.com/")).toBe("wss://navvied.com/relay/ws");
    expect(relayUrlFor("http://127.0.0.1:8803")).toBe("ws://127.0.0.1:8803/relay/ws");
  });
  test("joining tells the account the name and a new secret, and keeps a device that needs no question; joining again keeps the same secret", async () => {
    const devices = store();
    const sent: { name: string; secret: string; auth: string }[] = [];
    const send = (async (_url: string, init: RequestInit) => { sent.push({ ...JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization }); return reply(201, { id: "11111111-1111-1111-1111-111111111111" }); }) as unknown as typeof fetch;
    expect(await connectThisComputer(send, account, devices, "Zoe's laptop")).toBe(true);
    const d = devices.list()[0]!;
    expect(d).toMatchObject({ kind: "relay", label: "Zoe's laptop", account: "11111111-1111-1111-1111-111111111111" });
    expect(d.pending).toBeUndefined();
    expect(sent[0]).toMatchObject({ name: "Zoe's laptop", secret: d.secret, auth: "Bearer nv_t" });
    expect(sent[0]!.secret).toHaveLength(43);
    expect(await connectThisComputer(send, account, devices, "Zoe's laptop")).toBe(false);
    expect(devices.list()).toHaveLength(1);
    expect(sent[1]!.secret).toBe(sent[0]!.secret);
  });
  test("a server that refuses leaves nothing behind", async () => {
    const devices = store();
    const send = (async () => reply(422, { error: { message: "An account can connect 10 computers. Remove one first.", type: "invalid" } })) as unknown as typeof fetch;
    await expect(connectThisComputer(send, account, devices, "pc")).rejects.toThrow("10 computers");
    expect(devices.list()).toEqual([]);
  });
  test("leaving takes it off the account and forgets the device", async () => {
    const devices = store();
    const calls: string[] = [];
    const send = (async (url: string, init: RequestInit) => { calls.push(`${init.method} ${new URL(url).pathname}`); return reply(init.method === "POST" ? 201 : 200, { id: "22222222-2222-2222-2222-222222222222" }); }) as unknown as typeof fetch;
    await connectThisComputer(send, account, devices, "pc");
    const forgotten: string[] = [];
    await disconnectThisComputer(send, account, devices, (id) => { forgotten.push(id); devices.remove(id); });
    expect(calls).toEqual(["POST /api/account/computers", "DELETE /api/account/computers/22222222-2222-2222-2222-222222222222"]);
    expect(forgotten).toHaveLength(1);
    expect(devices.list()).toEqual([]);
  });
});
