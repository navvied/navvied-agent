import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../install.sh");
const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-install-")); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const fakeProgram = (version: string) => `#!/bin/sh\necho "navvied ${version}"\n`;
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let server: ReturnType<typeof Bun.serve>;
let assets: Record<string, string> = {};
let requested: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requested.push(path);
      const body = assets[path];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
});
afterAll(() => server.stop(true));

function release(prefix: string, programs: Record<string, string>, sums: Record<string, string> = {}): void {
  assets = {};
  const lines: string[] = [];
  for (const [name, text] of Object.entries(programs)) {
    assets[`${prefix}/${name}`] = text;
    lines.push(`${sums[name] ?? sha(text)}  ${name}`);
  }
  assets[`${prefix}/SHA256SUMS`] = `${lines.join("\n")}\n`;
}

const envFor = (home: string, dir: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "", HOME: home, SHELL: "/bin/zsh", NAVVIED_RELEASE_URL: `http://127.0.0.1:${server.port}/latest`,
  NAVVIED_INSTALL_DIR: dir, NAVVIED_OS: "linux", NAVVIED_ARCH: "x86_64", NAVVIED_LIBC: "glibc", NAVVIED_AVX2: "yes", ...extra,
});

async function sh(env: Record<string, string>, args: string[] = []) {
  const p = Bun.spawn(["sh", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

async function install(args: string[] = [], extra: Record<string, string> = {}) {
  const home = tmp(), dir = join(home, "bin");
  return { ...(await sh(envFor(home, dir, extra), args)), home, dir, binary: join(dir, "navvied") };
}

async function run(binary: string): Promise<string> {
  const p = Bun.spawn([binary], { stdout: "pipe" });
  return new Response(p.stdout).text();
}

describe.skipIf(process.platform === "win32")("install.sh", () => {
  test("installs the program for this machine, verified, executable, and says what to type", async () => {
    release("/latest", { "navvied-linux-x64": fakeProgram("1.2.3") });
    const r = await install();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Downloading navvied-linux-x64");
    expect(r.out).toContain("Installed navvied 1.2.3");
    expect(statSync(r.binary).mode & 0o111).not.toBe(0);
    expect(await run(r.binary)).toBe("navvied 1.2.3\n");
    expect(existsSync(`${r.binary}.new`)).toBe(false);
  });

  test("--then web installs, then starts navvied with the web command", async () => {
    release("/latest", { "navvied-linux-x64": `#!/bin/sh\n[ "$1" = "--version" ] && echo "navvied 1.2.3" && exit 0\necho "started with: $@"\n` });
    const r = await install(["--then", "web"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed navvied 1.2.3");
    expect(r.out).toContain("Starting navvied...");
    expect(r.out).toContain("started with: web");
  });
  test("--then accepts only web, and refuses before downloading anything", async () => {
    release("/latest", { "navvied-linux-x64": fakeProgram("1.2.3") });
    requested = [];
    const r = await install(["--then", "rm"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--then must be web");
    expect(requested).toEqual([]);
    expect(existsSync(r.binary)).toBe(false);
  });
  test("puts the folder on PATH once, in the shell's startup file, and says to open a new terminal", async () => {
    release("/latest", { "navvied-linux-x64": fakeProgram("1.0.0") });
    const r = await install();
    expect(readFileSync(join(r.home, ".zshrc"), "utf8")).toContain(`export PATH="${r.dir}:$PATH"`);
    expect(r.out).toMatch(/Open a new terminal/);
    expect((await sh(envFor(r.home, r.dir))).code).toBe(0);
    expect(readFileSync(join(r.home, ".zshrc"), "utf8").split(r.dir).length - 1).toBe(1);
  });

  test("leaves the startup file alone when the folder is already on PATH", async () => {
    release("/latest", { "navvied-linux-x64": fakeProgram("1.0.0") });
    const home = tmp(), dir = join(home, "bin");
    const r = await sh(envFor(home, dir, { PATH: `${dir}:${process.env.PATH}` }));
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(r.out).toContain("Type: navvied");
  });

  test.each([["/bin/bash", ".bashrc"], ["/usr/bin/fish", ".config/fish/config.fish"]])("uses the right startup file for %s", async (shell, rcName) => {
    release("/latest", { "navvied-linux-x64": fakeProgram("1.0.0") });
    const r = await install([], { SHELL: shell });
    expect(existsSync(join(r.home, rcName))).toBe(true);
  });

  test("a checksum mismatch installs nothing and leaves an existing install alone", async () => {
    release("/latest", { "navvied-linux-x64": fakeProgram("6.6.6") }, { "navvied-linux-x64": "0".repeat(64) });
    const home = tmp(), dir = join(home, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "navvied"), fakeProgram("old"));
    chmodSync(join(dir, "navvied"), 0o755);
    const r = await sh(envFor(home, dir));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/checksum mismatch.*nothing was installed/);
    expect(readFileSync(join(dir, "navvied"), "utf8")).toContain("old");
  });

  test("a new version replaces the old one", async () => {
    const home = tmp(), dir = join(home, "bin");
    release("/latest", { "navvied-linux-x64": fakeProgram("2.0.0") });
    await sh(envFor(home, dir));
    release("/latest", { "navvied-linux-x64": fakeProgram("3.0.0") });
    await sh(envFor(home, dir));
    expect(await run(join(dir, "navvied"))).toBe("navvied 3.0.0\n");
  });

  test("a missing download, a missing checksum entry and an unsupported machine are reported plainly", async () => {
    release("/latest", {});
    expect((await install()).err).toMatch(/could not download .*navvied-linux-x64/);
    release("/latest", { "navvied-darwin-arm64": fakeProgram("1.0.0") });
    expect((await install([], { NAVVIED_OS: "darwin", NAVVIED_ARCH: "arm64" })).code).toBe(0);
    assets["/latest/SHA256SUMS"] = "";
    expect((await install([], { NAVVIED_OS: "darwin", NAVVIED_ARCH: "arm64" })).err).toMatch(/no checksum is listed for navvied-darwin-arm64/);
    expect((await install([], { NAVVIED_OS: "windows" })).err).toMatch(/unsupported system: windows/);
    expect((await install([], { NAVVIED_ARCH: "mips" })).err).toMatch(/unsupported processor: mips/);
    expect((await install(["--bogus"])).code).toBe(2);
  });

  test("machine names are mapped: aarch64 → arm64, amd64 → x64", async () => {
    release("/latest", { "navvied-linux-arm64": fakeProgram("1.0.0"), "navvied-linux-x64": fakeProgram("1.0.0") });
    requested = [];
    await install([], { NAVVIED_ARCH: "aarch64" });
    await install([], { NAVVIED_ARCH: "amd64" });
    expect(requested).toContain("/latest/navvied-linux-arm64");
    expect(requested).toContain("/latest/navvied-linux-x64");
  });

  test.each([
    [{ NAVVIED_LIBC: "musl" }, "navvied-linux-x64-musl"],
    [{ NAVVIED_LIBC: "musl", NAVVIED_ARCH: "aarch64" }, "navvied-linux-arm64-musl"],
    [{ NAVVIED_LIBC: "glibc", NAVVIED_AVX2: "no" }, "navvied-linux-x64-baseline"],
    [{ NAVVIED_LIBC: "glibc", NAVVIED_AVX2: "yes" }, "navvied-linux-x64"],
    [{ NAVVIED_LIBC: "glibc", NAVVIED_AVX2: "no", NAVVIED_ARCH: "arm64" }, "navvied-linux-arm64"],
    [{ NAVVIED_OS: "darwin", NAVVIED_ARCH: "x86_64", NAVVIED_AVX2: "no" }, "navvied-darwin-x64"],
  ])("picks the right build for the machine: %j", async (env, asset) => {
    release("/latest", { [asset]: fakeProgram("1.0.0") });
    const r = await install([], env);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Downloading ${asset}`);
  });

  test("on Windows, the unix script points to install.ps1", async () => {
    expect((await install([], { NAVVIED_OS: "mingw64_nt" })).err).toContain("install.ps1");
  });

  test("--version installs that release", async () => {
    release("/latest/download/v0.4.2", { "navvied-linux-x64": fakeProgram("0.4.2") });
    requested = [];
    const r = await install(["--version", "v0.4.2"], { NAVVIED_RELEASE_URL: `http://127.0.0.1:${server.port}/latest/download` });
    expect(r.code).toBe(0);
    expect(requested[0]).toBe("/latest/download/v0.4.2/navvied-linux-x64");
  });
});

describe("install.ps1", () => {
  const script = readFileSync(join(import.meta.dir, "../../../install.ps1"), "utf8");
  test("has no param block, so the one-line form that pipes it to iex works, and still reads -Then by hand", () => {
    expect(script.split("\n").some((l) => /^\s*param\s*\(/i.test(l))).toBe(false);
    expect(script).toContain("$args");
    expect(script).toContain('-Then');
    expect(script).toContain('if ($Then -eq "web")');
  });
});
