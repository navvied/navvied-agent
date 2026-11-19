import { describe, expect, test } from "bun:test";
import { encodeQr, qrPath, qrText } from "../src/qr.ts";

const LINK = `https://navvied.com/#relay=${"k3J_-".repeat(8)}abc`;

describe("a QR code for the pairing link", () => {
  test("it has the size of its version, and the three finder patterns in the corners", () => {
    const q = encodeQr(LINK);
    expect(q.size).toBe(q.version * 4 + 17);
    const dark = (x: number, y: number): boolean => q.modules[y]![x]!;
    for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]] as const) {
      for (let i = 0; i < 7; i++) { expect(dark(ox + i, oy)).toBe(true); expect(dark(ox + i, oy + 6)).toBe(true); expect(dark(ox, oy + i)).toBe(true); expect(dark(ox + 6, oy + i)).toBe(true); }
      expect(dark(ox + 3, oy + 3)).toBe(true);
      expect(dark(ox + 1, oy + 1)).toBe(false);
    }
  });
  test("the timing pattern alternates between the finders, and there is the one dark module", () => {
    const q = encodeQr(LINK);
    for (let i = 8; i < q.size - 8; i++) { expect(q.modules[6]![i]).toBe(i % 2 === 0); expect(q.modules[i]![6]).toBe(i % 2 === 0); }
    expect(q.modules[q.size - 8]![8]).toBe(true);
  });
  test("the smallest version that holds the text is used, and the same text gives the same code", () => {
    expect(encodeQr("hi").version).toBe(1);
    expect(encodeQr("x".repeat(100)).version).toBeGreaterThan(encodeQr("x".repeat(20)).version);
    expect(encodeQr(LINK).modules).toEqual(encodeQr(LINK).modules);
  });
  test("a stronger level needs a bigger code, and a text that cannot fit is refused", () => {
    expect(encodeQr(LINK, "H").version).toBeGreaterThanOrEqual(encodeQr(LINK, "L").version);
    expect(() => encodeQr("x".repeat(300))).toThrow("too long");
  });
  test("as text it is two modules to a line with a quiet zone, and as a path it has a square per dark module", () => {
    const q = encodeQr(LINK);
    const lines = qrText(q).split("\n");
    expect(lines.length).toBe(Math.ceil((q.size + 4) / 2));
    expect(new Set(lines.join("").split(""))).toEqual(new Set([" ", "▀", "▄", "█"]));
    expect((qrPath(q).match(/z/g) ?? []).length).toBe(q.modules.flat().filter(Boolean).length);
  });
});
