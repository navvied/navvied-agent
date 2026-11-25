import type { Provider } from "../types.ts";
import type { VisionRoute } from "./types.ts";

const SYSTEM = "You look at pictures for someone who cannot. Answer only what is asked, in plain words, and read out any text you can see.";

/** A model that sees pictures, as the route LookAt and Watch ask: one request with the pictures and the question, no tools, the answer as text. */
export const visionRoute = (provider: Provider): VisionRoute => async ({ images, question }, signal) => {
  const reply = await provider.stream(
    { system: SYSTEM, tools: [], messages: [{ role: "user", content: [{ type: "text", text: question }, ...images.map((i) => ({ type: "image" as const, mime: i.mime, data: i.data }))] }] },
    signal,
    { text() {}, thought() {}, toolStarted() {} },
  );
  return reply.content.trim();
};
