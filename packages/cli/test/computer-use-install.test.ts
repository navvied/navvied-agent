import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSigner, entryOf, install, unsafeEntry, type Run } from "../src/computer-use/install.ts";
import { PIN, supportOf, type Pin } from "../src/computer-use/pin.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const body = new TextEncoder().encode("not a real archive");
const pinFor = (hash: string, signer: Pin["assets"]["linux-x86_64"]["signer"] = { kind: "none" }): Pin => ({ ...PIN, base: "https://assets.test/v", assets: { ...PIN.assets, "linux-x86_64": { ...PIN.assets["linux-x86_64"], sha256: hash, signer } } });
const serve = (): typeof fetch => (async () => new Response(body, { status: 200, headers: { "content-length": String(body.length) } })) as unknown as typeof fetch;
/** A system whose `tar` lists `names` and, when asked to unpack, puts the program where the pin says. */
const tarOf = (names: string[], unpackedTo?: (dir: string) => void): Run => async (cmd, args) => {
  if (cmd === "tar" && args[0] === "-tf") return { code: 0, out: names.join("\n"), err: "" };
  if (cmd === "tar" && args[0] === "-xf") { unpackedTo?.(args[3]!); return { code: 0, out: "", err: "" }; }
  return { code: 1, out: "", err: "" };
};
const here = (dir: string) => writeFileSync(join(dir, "cua-driver"), "#!/bin/sh\n");
const input = (dir: string, pin: Pin, run: Run) => ({ fetchFn: serve(), run, dir, pin, target: "linux-x86_64" as const, platform: "linux" });

describe("the pinned driver", () => {
  test("every target has a hash of the right shape and a program path", () => {
    for (const a of Object.values(PIN.assets)) { expect(a.sha256).toMatch(/^[0-9a-f]{64}$/); expect(a.asset).toContain(PIN.version); expect(a.entry).toBeTruthy(); }
  });
  test("a Wayland session is refused before anything is fetched, and Wayland with X11 forwarded is still Wayland", () => {
    expect(supportOf("linux", "x64", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toMatchObject({ ok: false, why: "wayland" });
    expect(supportOf("linux", "x64", { WAYLAND_DISPLAY: "wayland-0" })).toMatchObject({ ok: false, why: "wayland" });
    expect(supportOf("linux", "x64", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toEqual({ ok: true, target: "linux-x86_64" });
    expect(supportOf("linux", "arm64", { DISPLAY: ":0" })).toEqual({ ok: true, target: "linux-arm64" });
    expect(supportOf("linux", "x64", {})).toMatchObject({ ok: false, why: "platform" });
    expect(supportOf("darwin", "arm64", {})).toEqual({ ok: true, target: "darwin" });
    expect(supportOf("win32", "x64", {})).toEqual({ ok: true, target: "windows-x86_64" });
    expect(supportOf("freebsd", "x64", {})).toMatchObject({ ok: false });
  });
});

describe("installing the driver", () => {
  test("a download whose hash is not the pinned one is thrown away and nothing is unpacked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-"));
    const r = await install(input(dir, pinFor("0".repeat(64)), tarOf(["cua-driver"], here)));
    expect(r).toMatchObject({ ok: false, why: "download", result: { why: "wrong" } });
    expect(existsSync(entryOf(dir, pinFor("0".repeat(64)), "linux-x86_64"))).toBe(false);
  });
  test("a good archive is unpacked and the program is marked runnable; asking again fetches nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-"));
    const pin = pinFor(sha(body));
    const r = await install(input(dir, pin, tarOf(["cua-driver"], here)));
    expect(r).toEqual({ ok: true, entry: entryOf(dir, pin, "linux-x86_64") });
    const again = await install({ ...input(dir, pin, tarOf([])), fetchFn: (async () => { throw new Error("fetched"); }) as unknown as typeof fetch });
    expect(again.ok).toBe(true);
  });
  test("an archive that names a place outside its folder is never unpacked", async () => {
    expect(unsafeEntry(["a/b", "../evil"])).toBe("../evil");
    expect(unsafeEntry(["/etc/passwd"])).toBe("/etc/passwd");
    expect(unsafeEntry(["C:\\x", "ok"])).toBe("C:\\x");
    expect(unsafeEntry(["cua-driver", "dir/cua-driver"])).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "cu-"));
    let unpacked = false;
    const r = await install(input(dir, pinFor(sha(body)), tarOf(["../evil"], () => { unpacked = true; })));
    expect(r).toMatchObject({ ok: false, why: "unpack" });
    expect(unpacked).toBe(false);
  });
  test("an archive without the program, or one that fails to unpack, leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-"));
    const r = await install(input(dir, pinFor(sha(body)), tarOf(["other"], undefined)));
    expect(r).toMatchObject({ ok: false, why: "unpack" });
  });
  test("a program signed by someone else is removed again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cu-"));
    const pin = pinFor(sha(body), { kind: "apple", teamIds: ["TEAMOK"] });
    const run: Run = async (cmd, args) => {
      if (cmd === "codesign") return { code: 0, out: "", err: args[0] === "-dv" ? "TeamIdentifier=EVIL000000" : "" };
      return tarOf(["cua-driver"], here)(cmd, args);
    };
    const r = await install({ ...input(dir, pin, run), platform: "darwin", target: "linux-x86_64" });
    expect(r).toMatchObject({ ok: false, why: "signature" });
    expect(existsSync(entryOf(dir, pin, "linux-x86_64"))).toBe(false);
  });
});

describe("signatures, by the system's own check", () => {
  const apple = { kind: "apple", teamIds: ["AAA", "BBB"] } as const;
  test("macOS: valid and one of the pinned team ids", async () => {
    const run = (team: string, code = 0): Run => async (_c, a) => ({ code: a[0] === "--verify" ? code : 0, out: "", err: `Authority=x\nTeamIdentifier=${team}\n` });
    expect(await checkSigner(run("BBB"), apple, "/x", "darwin")).toBeUndefined();
    expect(await checkSigner(run("ZZZ"), apple, "/x", "darwin")).toBeTruthy();
    expect(await checkSigner(run("AAA", 1), apple, "/x", "darwin")).toBeTruthy();
    expect(await checkSigner(async () => ({ code: 0, out: "", err: "no team here" }), apple, "/x", "darwin")).toBeTruthy();
  });
  test("Windows: the status must be Valid and the publisher exactly the pinned one", async () => {
    const win = { kind: "authenticode", subject: "Cua AI, Inc." } as const;
    const says = (status: string, subject: string): Run => async () => ({ code: 0, out: JSON.stringify({ status, subject }), err: "" });
    expect(await checkSigner(says("Valid", 'CN="Cua AI, Inc.", O="Cua AI, Inc.", L=SF'), win, "x.exe", "win32")).toBeUndefined();
    expect(await checkSigner(says("Valid", "CN=Cua AI, Inc. Evil"), win, "x.exe", "win32")).toBeTruthy();
    expect(await checkSigner(says("NotSigned", ""), win, "x.exe", "win32")).toBeTruthy();
    expect(await checkSigner(async () => ({ code: 1, out: "garbage", err: "" }), win, "x.exe", "win32")).toBeTruthy();
  });
});
