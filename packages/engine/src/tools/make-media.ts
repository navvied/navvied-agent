import { extname } from "node:path";
import type { Tool, ToolContext } from "../types.ts";
import { attempt, providerOf, save, sourceFile } from "./media-files.ts";
import { num, str } from "./util.ts";

/** The sizes a model may ask for, in short words: what it can say is limited, what the provider is sent is a size in pixels. */
const SIZES: Record<string, string> = { small: "512x512", large: "1024x1024", wide: "1024x576", tall: "576x1024" };
const PICTURES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MOST_REFERENCE = 10_000_000;

/** A picture the person named, to start from: a project file of a kind providers take. */
function reference(ctx: ToolContext, p: unknown): string | undefined | { error: string } {
  if (!str(p).trim()) return undefined;
  const from = sourceFile(ctx, p, MOST_REFERENCE, "a starting picture");
  if (typeof from === "string") return { error: from };
  return PICTURES.has(extname(from.path).toLowerCase()) ? from.path : { error: `Error: ${from.path} is not a png, jpg or webp picture.` };
}

export const makeImage: Tool = {
  name: "MakeImage",
  readOnly: false,
  needs: "image",
  offeredWhen: ({ small }) => !small,
  description: "Draw a picture from a description and save it as a file. size: small, large, wide or tall.",
  parameters: { type: "object", properties: { prompt: { type: "string" }, file_path: { type: "string" }, size: { type: "string" }, reference: { type: "string" }, overwrite: { type: "boolean" } }, required: ["prompt"] },
  title: (a) => `Make a picture: ${str(a.prompt).slice(0, 50).replace(/\s+/g, " ")}`,
  async run(a, ctx) {
    const provider = providerOf(ctx, "image");
    if (typeof provider === "string") return provider;
    const prompt = str(a.prompt).trim();
    if (!prompt) return `Error: the prompt is empty. Retry: ${JSON.stringify({ prompt: "what the picture shows" })}`;
    const word = str(a.size).trim().toLowerCase();
    const size = word ? SIZES[word] ?? (/^\d{3,4}x\d{3,4}$/.test(word) ? word : undefined) : undefined;
    if (word && !size) return `Error: size "${word}" is not one of small, large, wide, tall.`;
    const ref = reference(ctx, a.reference);
    if (typeof ref === "object") return ref.error;
    return attempt(async () => save(ctx, a, "image", "png", await provider.run({ prompt, ...(size ? { size } : {}), ...(ref ? { reference: ref } : {}) }, ctx.signal)));
  },
};

export const makeVideo: Tool = {
  name: "MakeVideo",
  readOnly: false,
  needs: "video",
  offeredWhen: ({ small }) => !small,
  description: "Make a short video from a description and save it as a file. seconds: 1 to 30.",
  parameters: { type: "object", properties: { prompt: { type: "string" }, file_path: { type: "string" }, seconds: { type: "number" }, image: { type: "string" }, overwrite: { type: "boolean" } }, required: ["prompt"] },
  title: (a) => `Make a video: ${str(a.prompt).slice(0, 50).replace(/\s+/g, " ")}`,
  async run(a, ctx) {
    const provider = providerOf(ctx, "video");
    if (typeof provider === "string") return provider;
    const prompt = str(a.prompt).trim();
    if (!prompt) return `Error: the prompt is empty. Retry: ${JSON.stringify({ prompt: "what the video shows" })}`;
    const seconds = a.seconds === undefined ? undefined : Math.min(30, Math.max(1, Math.round(num(a.seconds, 5))));
    const first = reference(ctx, a.image);
    if (typeof first === "object") return first.error;
    return attempt(async () => save(ctx, a, "video", "mp4", await provider.run({ prompt, ...(seconds ? { seconds } : {}), ...(first ? { image: first } : {}) }, ctx.signal)));
  },
};
