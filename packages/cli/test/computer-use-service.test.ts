import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUse, type ServiceInput } from "../src/computer-use/service.ts";
import { PIN } from "../src/computer-use/pin.ts";
import { spawnChild, probeStatus } from "../src/computer-use/system.ts";

const fixture = join(import.meta.dir, "fixtures", "fake-driver.ts");
const base = (over: Partial<ServiceInput> = {}): ServiceInput => ({
  platform: process.platform, arch: process.arch === "arm64" ? "arm64" : "x64", env: { DISPLAY: ":0", PATH: process.env.PATH }, dir: mkdtempSync(join(tmpdir(), "cu-")), fetchFn: fetch,
  run: async () => ({ code: 0, out: "", err: "" }), spawn: spawnChild, probe: probeStatus, pid: process.pid, ownApps: ["navvied"],
  install: async () => ({ ok: true, entry: fixture }), pin: PIN, ...over,
});

describe("the screen for the conversations of one program", () => {
  test.skipIf(process.platform !== "linux")("the driver is started on first use, shared by every conversation, and stopped with the service", async () => {
    let installs = 0;
    const svc = new ComputerUse(base({ install: async () => { installs++; return { ok: true, entry: fixture }; } }));
    const a = svc.helper(), b = svc.helper();
    expect(installs).toBe(0);
    const [r1, r2] = await Promise.all([a.call({ action: "wait", seconds: 0 }), b.call({ action: "list" })]);
    expect(r1.verdict).toBe("delivered");
    expect(r2.verdict === "delivered" || r2.verdict === "refused").toBe(true);
    expect(installs).toBe(1);
    await svc.close();
  });
  test("a system that cannot be driven is refused with the reason, before anything is fetched", async () => {
    let installs = 0;
    const svc = new ComputerUse(base({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, install: async () => { installs++; return { ok: true, entry: fixture }; } }));
    const r = await svc.helper().call({ action: "list" });
    expect(r).toMatchObject({ verdict: "refused", code: "background_unavailable", next: expect.stringContaining("Wayland") });
    expect(installs).toBe(0);
  });
  test("a driver that cannot be installed is refused in plain words, with nothing of the cause", async () => {
    const svc = new ComputerUse(base({ install: async () => ({ ok: false, why: "signature", message: "/secret/path: bad" }) }));
    const r = await svc.helper().call({ action: "list" });
    expect(r.verdict).toBe("refused");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
  test("Stop reaches every conversation; the person's own screen use is respected", async () => {
    let human = false;
    const svc = new ComputerUse(base({ humanHasControl: () => human }));
    const a = svc.helper();
    svc.halt();
    expect(await a.call({ action: "list" })).toMatchObject({ code: "human_has_control" });
    svc.resume(); human = true;
    expect(await a.call({ action: "list" })).toMatchObject({ code: "human_has_control" });
  });
});
