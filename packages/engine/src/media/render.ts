import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SIDE } from "./fit.ts";
import { lastLine, run } from "./run.ts";
import { MediaError } from "./types.ts";

const MS = 60_000;
/** The most a drawn page may weigh before it is made smaller (see `fit`), and the most that is read back at all. */
const MOST_BYTES = 30_000_000;

export type RendererKind = "pdftoppm" | "mutool" | "gs";
export interface Renderer { kind: RendererKind; path: string }

/** The programs that draw a PDF page, in the order they are tried. */
export const RENDERERS: readonly RendererKind[] = ["pdftoppm", "mutool", "gs"];

/** The first program of `RENDERERS` that `which` finds; `pdftoppm` may be given by its path. */
export function findRenderer(which: (name: string) => string | undefined, pdftoppm?: string): Renderer | undefined {
  if (pdftoppm) return { kind: "pdftoppm", path: pdftoppm };
  for (const kind of RENDERERS) { const path = which(kind); if (path) return { kind, path }; }
  return undefined;
}

/** What to run to draw one page, and the file it writes. Page numbers start at 1. */
function command(r: Renderer, pdf: string, page: number, stem: string): { argv: string[]; out: string } {
  const p = String(page);
  switch (r.kind) {
    case "pdftoppm": return { argv: [r.path, "-jpeg", "-jpegopt", "quality=80", "-scale-to", String(SIDE), "-f", p, "-l", p, "-singlefile", pdf, stem], out: `${stem}.jpg` };
    case "mutool": return { argv: [r.path, "draw", "-q", "-r", "110", "-o", `${stem}.png`, pdf, p], out: `${stem}.png` };
    case "gs": return { argv: [r.path, "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=jpeg", "-dJPEGQ=80", "-r110", `-dFirstPage=${p}`, `-dLastPage=${p}`, `-sOutputFile=${stem}.jpg`, pdf], out: `${stem}.jpg` };
  }
}

/** One page of a PDF as picture bytes (JPEG or PNG), drawn by a program run without a shell, with a time limit. */
export async function drawPage(r: Renderer, pdf: string, page: number, dir: string, signal: AbortSignal): Promise<{ path: string; bytes: Buffer }> {
  const { argv, out } = command(r, pdf, page, join(dir, `page-${page}`));
  const done = await run(argv, { cwd: dir, ms: MS, signal });
  if (done.code !== 0 || !existsSync(out)) throw new MediaError(`page ${page} could not be drawn${lastLine(done.err) ? `: ${lastLine(done.err)}` : "."}`);
  if (statSync(out).size > MOST_BYTES) throw new MediaError(`page ${page} came out too large to show.`);
  return { path: out, bytes: readFileSync(out) };
}
