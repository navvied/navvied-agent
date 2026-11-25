import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ArchiveError, extractArchive, type Limits } from "../src/archive.ts";
import { tar, zip } from "./archives.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const scratch = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => { dirs.forEach(remove); });

async function unpack(kind: "tar.gz" | "zip", bytes: Buffer, limits?: Limits): Promise<string> {
  const root = scratch();
  const file = join(root, "a");
  writeFileSync(file, kind === "zip" ? bytes : gzipSync(bytes));
  await extractArchive(file, join(root, "out"), kind, limits);
  return join(root, "out");
}
const refused = async (kind: "tar.gz" | "zip", bytes: Buffer, match: RegExp, limits?: Limits): Promise<string> => {
  const root = scratch();
  const file = join(root, "a");
  writeFileSync(file, kind === "zip" ? bytes : gzipSync(bytes));
  const err = await extractArchive(file, join(root, "out"), kind, limits).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ArchiveError);
  expect((err as Error).message).toMatch(match);
  return root;
};
const mode = (p: string): number => lstatSync(p).mode & 0o777;
const posix = process.platform !== "win32";

describe("a tar.gz archive", () => {
  test("files, folders, a link inside the folder and a long name are made, owner-only", async () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}.txt`;
    const out = await unpack("tar.gz", tar([
      { name: "top/", type: "5", mode: 0o755 },
      { name: "top/run", body: "#!/bin/sh\n", mode: 0o755 },
      { name: "top/data.txt", body: "hello" },
      { name: "top/lib.so", type: "2", link: "data.txt" },
      { name: "a".repeat(40), body: "x", prefix: long.slice(0, 20) },
    ]));
    expect(readFileSync(join(out, "top", "data.txt"), "utf8")).toBe("hello");
    expect(readlinkSync(join(out, "top", "lib.so"))).toBe("data.txt");
    expect(readFileSync(join(out, long.slice(0, 20), "a".repeat(40)), "utf8")).toBe("x");
    if (posix) {
      expect(mode(join(out, "top", "run"))).toBe(0o700);
      expect(mode(join(out, "top", "data.txt"))).toBe(0o600);
      expect(mode(join(out, "top"))).toBe(0o700);
    }
  });

  test("a name that leaves the folder, or is absolute, or has a backslash or a drive, is refused and nothing is written outside", async () => {
    for (const name of ["../escape.txt", "a/../../escape.txt", "/etc/escape.txt", "a\\b.txt", "C:/x.txt"]) {
      const root = await refused("tar.gz", tar([{ name, body: "x" }]), /name/);
      expect(existsSync(join(root, "escape.txt")), name).toBe(false);
    }
  });

  test("links that could lead out are refused: up, absolute, to the folder itself, and a file written through a link", async () => {
    await refused("tar.gz", tar([{ name: "l", type: "2", link: "../outside" }]), /link/);
    await refused("tar.gz", tar([{ name: "l", type: "2", link: "/etc/passwd" }]), /link/);
    await refused("tar.gz", tar([{ name: "l", type: "2", link: "." }]), /link/);
    await refused("tar.gz", tar([{ name: "a/l", type: "2", link: "../.." }]), /link/);
    await refused("tar.gz", tar([{ name: "d", type: "2", link: "sub" }, { name: "d/evil", body: "x" }]), /not a folder/);
  });

  test("hard links, devices and pipes are refused", async () => {
    for (const type of ["1", "3", "4", "6"]) await refused("tar.gz", tar([{ name: "x", type, link: "y" }]), /kind that is not allowed/);
  });

  test("a name twice, too many entries, a file or an archive that grows past its limit, folders too deep", async () => {
    await refused("tar.gz", tar([{ name: "a", body: "1" }, { name: "a", body: "2" }]), /twice/);
    const small: Limits = { entries: 3, bytes: 100, entryBytes: 60, depth: 3 };
    await refused("tar.gz", tar([1, 2, 3, 4].map((n) => ({ name: `f${n}` }))), /too many/, small);
    await refused("tar.gz", tar([{ name: "big", body: "x".repeat(61) }]), /larger than is allowed/, small);
    await refused("tar.gz", tar([{ name: "a", body: "x".repeat(60) }, { name: "b", body: "x".repeat(60) }]), /larger than is allowed/, small);
    await refused("tar.gz", tar([{ name: "a/b/c/d.txt", body: "x" }]), /too deep/, small);
  });

  test("a damaged or cut archive is refused in words", async () => {
    const bytes = tar([{ name: "f", body: "x".repeat(2000) }]);
    await refused("tar.gz", bytes.subarray(0, 700), /ends too early|damaged/);
    const bad = Buffer.from(bytes); bad[10] = 0x41;
    await refused("tar.gz", bad, /damaged/);
    const root = scratch();
    writeFileSync(join(root, "a"), "not an archive at all");
    expect(await extractArchive(join(root, "a"), join(root, "out"), "tar.gz").then(() => "ok", (e: unknown) => (e as Error).message)).toMatch(/damaged/);
  });

  test("a link that was made earlier is not written through even when the folder is made by hand first", async () => {
    const root = scratch();
    mkdirSync(join(root, "out"));
    symlinkSync(root, join(root, "out", "d"));
    const file = join(root, "a");
    writeFileSync(file, gzipSync(tar([{ name: "d/evil", body: "x" }])));
    await expect(extractArchive(file, join(root, "out"), "tar.gz")).rejects.toBeInstanceOf(ArchiveError);
    expect(existsSync(join(root, "evil"))).toBe(false);
  });
});

describe("a zip archive", () => {
  test("stored and deflated files, folders, and the execute bit", async () => {
    const out = await unpack("zip", zip([
      { name: "bin/", mode: 0o040755 },
      { name: "bin/tool", body: "program", mode: 0o100755 },
      { name: "notes.txt", body: "n".repeat(5000) },
      { name: "plain.txt", body: "p", store: true },
    ]));
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("n".repeat(5000));
    expect(readFileSync(join(out, "plain.txt"), "utf8")).toBe("p");
    if (posix) { expect(mode(join(out, "bin", "tool"))).toBe(0o700); expect(mode(join(out, "notes.txt"))).toBe(0o600); }
  });

  test("traversal, absolute names, links, encryption, 64-bit zips, a size that lies and a file past the limit are refused", async () => {
    await refused("zip", zip([{ name: "../x", body: "x" }]), /name/);
    await refused("zip", zip([{ name: "/x", body: "x" }]), /name/);
    await refused("zip", zip([{ name: "l", body: "target", mode: 0o120777 }]), /link/);
    await refused("zip", zip([{ name: "s", body: "x", flags: 1 }]), /encrypted/);
    await refused("zip", zip([{ name: "s", body: "x" }], { zip64: true }), /64-bit/);
    await refused("zip", zip([{ name: "lie", body: "x".repeat(100), lie: 10 }]), /damaged or larger/);
    await refused("zip", zip([{ name: "big", body: "x".repeat(100) }]), /larger than is allowed/, { entries: 5, bytes: 1000, entryBytes: 50, depth: 5 });
    await refused("zip", zip([{ name: "a", body: "x".repeat(40) }, { name: "b", body: "x".repeat(40) }]), /larger than is allowed/, { entries: 5, bytes: 60, entryBytes: 50, depth: 5 });
  });

  test("a file that is not a zip is refused", async () => {
    await refused("zip", Buffer.from("PK nothing here"), /not a zip/);
  });
});
