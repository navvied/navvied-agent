import { Media, visionRoute, type MediaServer, type Need, type Provider } from "@navvied/engine";
import type { MediaConfig } from "./media-config.ts";
import { accountPath } from "./config.ts";
import { DEFAULT_SERVER, readAccount } from "./account.ts";

/** Where the media routes are, and for whom: a hosted session's own service, or this computer's account. A guest and a sandbox have none. */
export function mediaServer(env: Record<string, string | undefined>, o: { config?: string; sandboxed?: boolean; webProxy?: { url: string; token: string } }): () => MediaServer | undefined {
  return () => {
    if (o.webProxy) return { url: o.webProxy.url.replace(/\/web$/, "/media"), token: o.webProxy.token };
    if (o.sandboxed) return undefined;
    const account = readAccount(accountPath(env, o.config));
    return account ? { url: `${(account.server ?? env.NAVVIED_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, "")}/api/media`, token: account.token } : undefined;
  };
}

/** What can make, hear or look at media in a conversation: the engines of this computer first, then the service. `vision` is the model that looks, when there is one. */
export function mediaFor(env: Record<string, string | undefined>, config: MediaConfig | undefined, o: { config?: string; sandboxed?: boolean; webProxy?: { url: string; token: string } }, vision?: Provider): Media {
  return new Media({
    ...(config ? { local: config } : {}),
    ...(config?.pdftoppm ? { pdftoppm: config.pdftoppm } : {}),
    server: mediaServer(env, o),
    ...(vision ? { vision: visionRoute(vision) } : {}),
  });
}

/** The row of the tools list for each need: the one place that says which switch stands for which kind. */
export const ROW_NEED: Readonly<Record<string, Need>> = { vision: "look", "speech-to-text": "stt", "text-to-speech": "tts", image: "image", "video-generation": "video", "video-analysis": "watch" };
