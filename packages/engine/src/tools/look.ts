import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { classifyFile } from "@navvied/protocol";
import { SHRINK_FROM, pageImage, sampleFrames, shrink } from "../media/frames.ts";
import { MediaError, type VisionRoute } from "../media/types.ts";
import type { Tool, ToolContext } from "../types.ts";
import { attempt, sizeWords, sourceFile } from "./media-files.ts";
import { clip, num, str } from "./util.ts";

const MOST_PICTURE = 12_000_000, MOST_PDF = 100_000_000, MOST_VIDEO = 2_000_000_000;
const FRAMES = 6;
const ASK = "Describe what you see in detail, and read out any text.";
const NO_ROUTE = "Error: no model that sees pictures is set up on this computer.";

/** The answer of the model that looks, framed: what a picture or a video says is not an instruction. */
const framed = (what: string, answer: string): string => clip(`${what}:\n${answer || "The model that looks gave no answer."}`);

async function withScratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "navvied-media-"));
  try { return await use(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ask = (route: VisionRoute, images: { mime: string; data: string }[], question: string, ctx: ToolContext): Promise<string> => route({ images, question }, ctx.signal);

export const lookAt: Tool = {
  name: "LookAt",
  readOnly: true,
  fromOutside: true,
  needs: "look",
  offeredWhen: ({ small, userText }) => !small && (/\b(look at|screenshots?|pictures?|images?|photos?|diagrams?|charts?|scans?|scanned|figure|png|jpe?g|webp|gif)\b/i.test(userText) || /\.(pdf|png|jpe?g|gif|webp)\b/i.test(userText)),
  description: "Look at a picture or one page of a PDF and answer a question about it in words.",
  parameters: { type: "object", properties: { file_path: { type: "string" }, question: { type: "string" }, page: { type: "number" } }, required: ["file_path"] },
  title: (a) => `Look at ${str(a.file_path)}`,
  async run(a, ctx) {
    const route = ctx.media?.look;
    if (!route) return NO_ROUTE;
    const pdf = extname(str(a.file_path)).toLowerCase() === ".pdf";
    const from = sourceFile(ctx, a.file_path, pdf ? MOST_PDF : MOST_PICTURE, pdf ? "a PDF" : "a picture");
    if (typeof from === "string") return from;
    const question = str(a.question).trim() || ASK;
    return attempt(async () => {
      if (pdf) {
        const pdftoppm = ctx.media?.program("pdftoppm");
        if (!pdftoppm) return `Error: drawing a PDF page needs pdftoppm, which is not installed. Read ${from.path} to get its text instead.`;
        const page = Math.max(1, Math.floor(num(a.page, 1)));
        return withScratch(async (dir) => framed(`${from.path}, page ${page}`, await ask(route, [await pageImage(pdftoppm, from.path, page, dir, ctx.signal)], question, ctx)));
      }
      const bytes = readFileSync(from.path);
      const kind = classifyFile(bytes);
      if (kind.kind !== "image") throw new MediaError(`${from.path} is not a picture (png, jpg, gif or webp). Use Read for text, and Watch for a video.`);
      const ffmpeg = ctx.media?.program("ffmpeg");
      // A large picture is made smaller first, as the best agents do: the model sees it no better, and the request is lighter.
      const small = ffmpeg && from.size > SHRINK_FROM ? await withScratch((dir) => shrink(ffmpeg, from.path, dir, ctx.signal)) : undefined;
      const image = small ?? { mime: kind.mime, data: bytes.toString("base64") };
      return framed(`${from.path} (${kind.mime}, ${sizeWords(from.size)}${small ? ", made smaller" : ""})`, await ask(route, [image], question, ctx));
    });
  },
};

export const watch: Tool = {
  name: "Watch",
  readOnly: true,
  fromOutside: true,
  needs: "watch",
  offeredWhen: ({ small, userText }) => !small && (/\b(video|clip|footage|screen ?recording|watch)\b/i.test(userText) || /\.(mp4|mov|mkv|webm|avi|m4v)\b/i.test(userText)),
  description: "Look through a video and answer a question about what happens in it, in words.",
  parameters: { type: "object", properties: { file_path: { type: "string" }, question: { type: "string" } }, required: ["file_path"] },
  title: (a) => `Watch ${str(a.file_path)}`,
  async run(a, ctx) {
    const route = ctx.media?.look, ffmpeg = ctx.media?.program("ffmpeg");
    if (!route || !ffmpeg) return NO_ROUTE;
    const from = sourceFile(ctx, a.file_path, MOST_VIDEO, "a video");
    if (typeof from === "string") return from;
    const question = str(a.question).trim() || ASK;
    return attempt(() => withScratch(async (dir) => {
      const { seconds, frames } = await sampleFrames(ffmpeg, from.path, FRAMES, dir, ctx.signal);
      const when = frames.map((f) => `${f.at.toFixed(1)}s`).join(", ");
      const answer = await ask(route, frames, `These ${frames.length} pictures are frames taken evenly, in order, from a video ${seconds.toFixed(1)} seconds long (at ${when}). ${question}`, ctx);
      return framed(`${from.path} (${sizeWords(from.size)}, ${seconds.toFixed(1)} seconds, ${frames.length} frames looked at)`, answer);
    }));
  },
};
