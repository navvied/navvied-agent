/**
 * Writes a small real picture with a label a person (or a model that sees) can read: black letters on white, 12 pixels to a dot, and the
 * label again in a text chunk, which is what the scripted model reads. `bun make-chart.ts chart.png`
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const LABEL = "revenue 42";
const GLYPHS: Record<string, string[]> = {
  r: ["#.##.", "##..#", "#....", "#....", "#...."],
  e: [".###.", "#...#", "#####", "#....", ".####"],
  v: ["#...#", "#...#", "#...#", ".#.#.", "..#.."],
  n: ["#.##.", "##..#", "#...#", "#...#", "#...#"],
  u: ["#...#", "#...#", "#...#", "#..##", ".##.#"],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  " ": [],
};
const SCALE = 12, MARGIN = 3, CELL = 6;
const width = (LABEL.length * CELL + MARGIN * 2) * SCALE, height = (7 + MARGIN * 2) * SCALE;
const rows: Buffer[] = [];
const pixels = Array.from({ length: height }, () => Buffer.alloc(width, 255));
[...LABEL].forEach((ch, i) => {
  const glyph = GLYPHS[ch] ?? [];
  const top = glyph.length === 5 ? 2 : 0;
  glyph.forEach((line, y) => [...line].forEach((dot, x) => {
    if (dot !== "#") return;
    for (let dy = 0; dy < SCALE; dy++) pixels[(MARGIN + top + y) * SCALE + dy]!.fill(0, (MARGIN + i * CELL + x) * SCALE, (MARGIN + i * CELL + x + 1) * SCALE);
  }));
});
for (const p of pixels) rows.push(Buffer.concat([Buffer.from([0]), p]));

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("tEXt", Buffer.from(`Comment\0bar label: ${LABEL}`, "latin1")),
  chunk("IDAT", deflateSync(Buffer.concat(rows))),
  chunk("IEND", Buffer.alloc(0)),
]);

const FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/liberation/LiberationSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"];

/** A small model that sees reads a real typeface and not letters made of squares: with ffmpeg and a bold font the label is drawn in it, and the text chunk is put in. Otherwise the squares above are used. */
function drawn(): Buffer | undefined {
  const font = FONTS.find((f) => existsSync(f)), ffmpeg = Bun.which("ffmpeg");
  if (!font || !ffmpeg) return undefined;
  const file = join(tmpdir(), `navvied-chart-${process.pid}.png`);
  const r = Bun.spawnSync([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=800x200:d=1", "-vf", `drawtext=fontfile=${font}:text='${LABEL}':fontsize=110:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", file]);
  try {
    if (r.exitCode !== 0) return undefined;
    const bytes = readFileSync(file);
    const at = bytes.indexOf("IDAT") - 4;
    return Buffer.concat([bytes.subarray(0, at), chunk("tEXt", Buffer.from(`Comment\0bar label: ${LABEL}`, "latin1")), bytes.subarray(at)]);
  } finally { rmSync(file, { force: true }); }
}

writeFileSync(process.argv[2] ?? "chart.png", drawn() ?? png);
