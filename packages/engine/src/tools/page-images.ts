import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fit, type Image } from "../media/fit.ts";
import { Media } from "../media/media.ts";
import { drawPage } from "../media/render.ts";
import { MediaError } from "../media/types.ts";
import type { ToolContext } from "../types.ts";

/** Where a picture a tool made arrives: in a message of its own that the tool sent, so the model does not take it for something the person wrote. */
export const PICTURE_FOLLOWS = "in the next message (sent by this tool, not written by the person)";

/** Most pages drawn for one call, and the most one drawn page may weigh once made smaller: what is not asked for or too heavy is not sent. */
export const MOST_DRAWN = 8, MOST_PAGE_BYTES = 2_500_000;
export const NO_RENDERER = "Page images need pdftoppm, mutool or gs on this computer; none was found.";

let real: Media | undefined;
/** What draws and shrinks here: the conversation's own, else the programs on the path. */
export const mediaOf = (ctx: ToolContext): Media => ctx.media ?? (real ??= new Media());

export async function withScratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "navvied-media-"));
  try { return await use(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** One page of a PDF as a picture a model gets: drawn, then made smaller when it is large. Nothing when there is no program to draw it. Throws a `MediaError` in words. */
export async function pageImage(media: Media, pdf: string, page: number, dir: string, signal: AbortSignal): Promise<Image | undefined> {
  const renderer = media.renderer();
  if (!renderer) return undefined;
  const drawn = await drawPage(renderer, pdf, page, dir, signal);
  const image = await fit(media.shrinker(), drawn.path, drawn.bytes, dir, signal);
  if (Buffer.byteLength(image.data, "base64") > MOST_PAGE_BYTES) throw new MediaError(`page ${page} is too heavy to show${media.shrinker() ? "" : " (no program to make it smaller was found)"}.`);
  return { mime: image.mime, data: image.data };
}

/**
 * Draws the asked pages and shows them to the model (as the next message's pictures). The answer is the line to put under the text of those pages:
 * which pages are shown, which could not be, and what to do when there is no program. Never says a page was seen when it was not.
 */
export async function showPages(ctx: ToolContext, pdf: string, pages: number[]): Promise<string> {
  const media = mediaOf(ctx);
  if (!media.renderer()) return NO_RENDERER;
  const asked = pages.slice(0, MOST_DRAWN), shown: number[] = [], failed: string[] = [];
  await withScratch(async (dir) => {
    for (const p of asked) {
      try {
        const image = await pageImage(media, pdf, p, dir, ctx.signal);
        if (image) { ctx.show?.({ type: "image", ...image }); shown.push(p); }
      } catch (e) { if (ctx.signal.aborted) throw e; failed.push(e instanceof MediaError ? e.message : `page ${p} could not be drawn.`); }
    }
  });
  const lines: string[] = [];
  if (shown.length) lines.push(`Page${shown.length === 1 ? "" : "s"} ${shown.join(", ")} ${shown.length === 1 ? "is" : "are"} shown to you as ${shown.length === 1 ? "a picture" : "pictures"} ${PICTURE_FOLLOWS}.`);
  if (pages.length > asked.length) lines.push(`Only the first ${MOST_DRAWN} pages are drawn per call; ask for the rest from page ${pages[MOST_DRAWN]}.`);
  for (const f of failed) lines.push(`${f[0]!.toUpperCase()}${f.slice(1)}`);
  return lines.join("\n");
}
