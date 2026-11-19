import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelEntry } from "./config.ts";

/** The navvied account this computer is signed in to: which server, and the token that stands for the person there. */
export interface Account { server: string; token: string; email: string }

/** One model of the account as the server lists it (see `GET /v1/models`). */
export interface HostedModel {
  id: string;
  name: string;
  brand?: string;
  badge?: string;
  blurb?: string;
  locked?: boolean;
  efforts?: ModelEntry["efforts"];
  api: "chat" | "messages" | "responses";
  window: number;
  reasoning: "effort" | "none";
}
export interface HostedModels { default?: string; /** The free models only: how many tokens a day without an account. */ tokensPerDay?: number; models: HostedModel[] }

export const DEFAULT_SERVER = "https://navvied.com";
export const HOSTED_PREFIX = "navvied-";
/** The free models of navvied.com that a computer may use without an account: their own names, apart from the account's and the computer's. */
export const GUEST_PREFIX = "navvied-free-";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, text, { mode: 0o600 });
  chmodSync(`${file}.new`, 0o600);
  renameSync(`${file}.new`, file);
}

export function readAccount(file: string): Account | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObject(raw) || typeof raw.server !== "string" || typeof raw.token !== "string" || typeof raw.email !== "string" || !raw.token) return undefined;
    return { server: raw.server, token: raw.token, email: raw.email };
  } catch { return undefined; }
}

export const writeAccount = (file: string, account: Account): void => writePrivate(file, `${JSON.stringify(account)}\n`);
export const clearAccount = (file: string): void => rmSync(file, { force: true });

export function readHostedModels(file: string): HostedModels | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObject(raw) || !Array.isArray(raw.models)) return undefined;
    return { ...(typeof raw.default === "string" ? { default: raw.default } : {}), ...(typeof raw.tokensPerDay === "number" ? { tokensPerDay: raw.tokensPerDay } : {}), models: raw.models.filter((m): m is HostedModel => isObject(m) && typeof m.id === "string" && typeof m.name === "string") };
  } catch { return undefined; }
}

export const writeHostedModels = (file: string, listing: HostedModels): void => writePrivate(file, `${JSON.stringify(listing)}\n`);
export const forgetHostedModels = (file: string): void => rmSync(file, { force: true });

/** The models of the account as entries of the model list, so every screen treats them like any other model. The brand name is what the person sees; the real model stays on the server. */
export function hostedEntries(account: Account, listing: HostedModels): Record<string, ModelEntry> {
  const entries: Record<string, ModelEntry> = {};
  for (const m of listing.models) {
    entries[`${HOSTED_PREFIX}${m.id}`] = {
      baseUrl: `${account.server.replace(/\/+$/, "")}/v1`,
      api: m.api,
      model: m.id,
      apiKey: account.token,
      window: m.window,
      reasoning: m.reasoning,
      ...(m.efforts?.length ? { efforts: m.efforts } : {}),
      display: { name: m.name, ...(m.brand ? { brand: m.brand } : {}), ...(m.badge ? { badge: m.badge } : {}), ...(m.blurb ? { blurb: m.blurb } : {}), ...(m.locked ? { locked: true } : {}) },
    };
  }
  return entries;
}

/** The free models as entries of the model list: no key (the server tells a computer by its network address), a note on the daily limit, and only the usable ones are not locked. */
export function guestEntries(server: string, listing: HostedModels & { tokensPerDay?: number }): Record<string, ModelEntry> {
  const entries: Record<string, ModelEntry> = {};
  const limit = listing.tokensPerDay ? ` Up to ${listing.tokensPerDay.toLocaleString("en-US")} tokens a day without an account.` : "";
  for (const m of listing.models) {
    entries[`${GUEST_PREFIX}${m.id}`] = {
      baseUrl: `${server.replace(/\/+$/, "")}/v1`,
      api: m.api,
      model: m.id,
      window: m.window,
      reasoning: m.reasoning,
      ...(m.efforts?.length ? { efforts: m.efforts } : {}),
      display: { name: m.name, brand: "navvied.com (free)", ...(m.badge ? { badge: m.badge } : {}), blurb: `Free on navvied.com.${limit}`, ...(m.locked ? { locked: true } : {}) },
    };
  }
  return entries;
}

export const hasAccountFile = (file: string): boolean => existsSync(file);
