/**
 * A QR code for a short text, with no dependency: byte mode, versions 1 to 10 (up to 213 bytes at level M), the smallest version that holds the text.
 * Written for the pairing link of the relay (`https://<site>/#relay=<secret>`, about 70 bytes), so a phone can scan it instead of the link being typed.
 * Follows ISO/IEC 18004; `qr.test.ts` checks its structure, and what it makes was decoded with a real reader (jsQR) for texts of every length it accepts, at all four levels.
 */

export type QrLevel = "L" | "M" | "Q" | "H";
export interface Qr { size: number; version: number; /** Row by row; `true` is a dark module. */ modules: boolean[][] }

const ECC_PER_BLOCK: Record<QrLevel, number[]> = { L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24], H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28] };
const BLOCKS: Record<QrLevel, number[]> = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5], Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8], H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8] };
const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
const LAST_VERSION = 10;

const rawModules = (v: number): number => {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) { const a = Math.floor(v / 7) + 2; n -= (25 * a - 10) * a - 55; if (v >= 7) n -= 36; }
  return n;
};
const dataCodewords = (v: number, l: QrLevel): number => Math.floor(rawModules(v) / 8) - (ECC_PER_BLOCK[l][v - 1] as number) * (BLOCKS[l][v - 1] as number);

/** Multiplication in GF(256) with the QR polynomial 0x11D. */
const mul = (x: number, y: number): number => {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
};

const divisor = (degree: number): number[] => {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = mul(r[j] as number, root); if (j + 1 < r.length) r[j] = (r[j] as number) ^ (r[j + 1] as number); }
    root = mul(root, 2);
  }
  return r;
};

const remainder = (data: number[], div: number[]): number[] => {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => { r[i] = (r[i] as number) ^ mul(c, factor); });
  }
  return r;
};

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/** The bytes of the message: mode, length, text, terminator and padding, to exactly the data capacity of the version. */
function dataBits(bytes: number[], v: number, l: QrLevel): number[] {
  const bits: number[] = [];
  const put = (value: number, n: number): void => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, v >= 10 ? 16 : 8);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(v, l) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] as number); out.push(b); }
  return out;
}

/** Splits into blocks, adds each block's error correction and interleaves them. */
function codewords(data: number[], v: number, l: QrLevel): number[] {
  const nBlocks = BLOCKS[l][v - 1] as number, eccLen = ECC_PER_BLOCK[l][v - 1] as number;
  const raw = Math.floor(rawModules(v) / 8);
  const nShort = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks);
  const div = divisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = remainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < (blocks[0] as number[]).length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i] as number); });
  }
  return out;
}

function alignmentPositions(v: number): number[] {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2;
  const size = v * 4 + 17;
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const maskOn = (mask: number, x: number, y: number): boolean => {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    default: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
  }
};

/** How badly a pattern would scan: long runs, 2x2 blocks, and an uneven balance of dark and light. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const same = (pass ? m[b]?.[a] : m[a]?.[b]) === (pass ? m[b - 1]?.[a] : m[a]?.[b - 1]);
        if (same) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y]?.[x]; if (c === m[y]?.[x + 1] && c === m[y + 1]?.[x] && c === m[y + 1]?.[x + 1]) score += 3; }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

/** Makes the code for `text`: the smallest version (1 to 10) that holds it at `level`. Throws when it does not fit. */
export function encodeQr(text: string, level: QrLevel = "M"): Qr {
  const bytes = utf8(text);
  let version = 1;
  while (version <= LAST_VERSION && Math.floor((dataCodewords(version, level) * 8 - 4 - (version >= 10 ? 16 : 8)) / 8) < bytes.length) version++;
  if (version > LAST_VERSION) throw new Error(`The text is too long for a code (${bytes.length} bytes).`);
  const size = version * 4 + 17;
  const data = codewords(dataBits(bytes, version, level), version, level);

  const dark: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean): void => { (dark[y] as boolean[])[x] = on; (fn[y] as boolean[])[x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = alignmentPositions(version);
  pos.forEach((px, i) => pos.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));

  const formatBits = (mask: number): number => {
    const d = (FORMAT_BITS[level] << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    return ((d << 10) | r) ^ 0x5412;
  };
  const drawFormat = (mask: number): void => {
    const bits = formatBits(mask);
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (version << 12) | r;
    for (let i = 0; i < 18; i++) { const on = ((bits >>> i) & 1) !== 0; const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, on); set(b, a, on); }
  }

  // the data, in two-column strips from the right, zigzagging up and down
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!(fn[y] as boolean[])[x] && i < data.length * 8) { (dark[y] as boolean[])[x] = (((data[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }

  let best: boolean[][] | undefined, bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = dark.map((row, y) => row.map((v, x) => (fn[y]?.[x] ? v : v !== maskOn(mask, x, y))));
    const saved = dark.map((r) => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) (dark[y] as boolean[])[x] = (m[y] as boolean[])[x] as boolean;
    drawFormat(mask);
    const score = penalty(dark);
    if (score < bestScore) { bestScore = score; bestMask = mask; best = dark.map((r) => r.slice()); }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) (dark[y] as boolean[])[x] = (saved[y] as boolean[])[x] as boolean;
  }
  void bestMask;
  return { size, version, modules: best as boolean[][] };
}

/** The code as an SVG path (one square per dark module, in module units), to draw at any size. The quiet zone is the page's to leave. */
export function qrPath(qr: Qr): string {
  let d = "";
  qr.modules.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}

/** The code as text for a terminal: two rows of modules to a line with half blocks, with a quiet zone of two modules. Dark modules are drawn light when `inverted` (a dark terminal). */
export function qrText(qr: Qr, inverted = true): string {
  const q = 2, n = qr.size + q * 2;
  const at = (x: number, y: number): boolean => (x >= q && y >= q && x < qr.size + q && y < qr.size + q ? (qr.modules[y - q]?.[x - q] ?? false) : false);
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = at(x, y) !== inverted, bottom = at(x, y + 1) !== inverted;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
