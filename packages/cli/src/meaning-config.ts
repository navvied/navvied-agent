import type { EmbeddingConfig } from "@navvied/engine";
import { isBaseAddress } from "@navvied/protocol";

/** What `memory.embeddings` holds in the configuration file: the server that turns text into vectors, which is the person's own. Off when absent. */
export interface EmbeddingSettings {
  baseUrl: string;
  model: string;
  api: "chat" | "ollama";
  apiKey?: string;
  /** Name of an environment variable that holds the key (preferred over `apiKey`). */
  apiKeyEnv?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (o: Record<string, unknown>, key: string): string | undefined => (typeof o[key] === "string" && (o[key] as string).trim() ? (o[key] as string).trim() : undefined);

/** The `memory.embeddings` object read and checked; an error says which key is wrong, in words (and never repeats a key). */
export function parseEmbeddings(raw: unknown): EmbeddingSettings | string {
  if (!isObj(raw)) return `"memory.embeddings" must be an object`;
  const baseUrl = text(raw, "baseUrl"), model = text(raw, "model");
  if (!baseUrl || !isBaseAddress(baseUrl)) return `"memory.embeddings.baseUrl" must be an https address, or http on this computer`;
  if (!model) return `"memory.embeddings.model" must name the embedding model`;
  if (raw.api !== "chat" && raw.api !== "ollama") return `"memory.embeddings.api" must be "chat" or "ollama"`;
  const key = text(raw, "apiKey"), keyEnv = text(raw, "apiKeyEnv");
  return { baseUrl, model, api: raw.api, ...(key ? { apiKey: key } : {}), ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) };
}

/** The server to ask, with its key read from the environment variable when one is named. */
export function embeddingConfig(settings: EmbeddingSettings | undefined, env: Record<string, string | undefined>): EmbeddingConfig | undefined {
  if (!settings) return undefined;
  const key = (settings.apiKeyEnv ? env[settings.apiKeyEnv] : undefined) ?? settings.apiKey;
  return { baseUrl: settings.baseUrl, model: settings.model, api: settings.api, ...(key ? { apiKey: key } : {}) };
}
