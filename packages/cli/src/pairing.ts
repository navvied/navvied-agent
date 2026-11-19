import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Device, DeviceStore } from "./devices.ts";

export type Decision = "once" | "always" | "no";
export type PairState = "waiting" | "allowed" | "denied" | "expired";

export interface Pairing {
  /** A website asks to use this engine. Refused quietly when the website is not one this engine serves, or when asked too often. */
  request(origin: string | null): { ok: true; id: string; code: string; expiresIn: number } | { ok: false; status: 403 | 429 };
  /** The website asks how its request is going. The key is given once, to the website that asked. */
  poll(id: string, origin: string | null): { state: PairState; key?: string } | undefined;
  /** Whether a key belongs to a website that was allowed. */
  accepts(key: string): boolean;
}

export interface PairingOptions {
  store: DeviceStore;
  /** Websites that may ask. */
  allowed: ReadonlySet<string>;
  /** Shows the question to the person and returns the answer. Called for one request at a time. */
  ask(question: { origin: string; code: string }): Promise<Decision>;
  now?: () => number;
  /** How long a request waits for an answer, in milliseconds. */
  waitMs?: number;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PER_ORIGIN = 5;
const WINDOW_MS = 60_000;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function newCode(): string {
  const pick = (): string => ALPHABET[randomInt(ALPHABET.length)]!;
  return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

export function createPairing(options: PairingOptions): Pairing {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 120_000;
  const pending = new Map<string, { origin: string; expires: number; state: PairState; key?: string; taken: boolean }>();
  const once = new Set<string>();
  const recent = new Map<string, number[]>();
  let asking = false;

  const tooMany = (origin: string): boolean => {
    const at = now();
    const times = (recent.get(origin) ?? []).filter((t) => at - t < WINDOW_MS);
    times.push(at);
    recent.set(origin, times);
    return times.length > PER_ORIGIN;
  };

  return {
    request(origin) {
      if (!origin || !options.allowed.has(origin)) return { ok: false, status: 403 };
      if (tooMany(origin) || asking) return { ok: false, status: 429 };
      const id = randomBytes(12).toString("base64url");
      const code = newCode();
      const entry = { origin, expires: now() + waitMs, state: "waiting" as PairState, taken: false } as { origin: string; expires: number; state: PairState; key?: string; taken: boolean };
      pending.set(id, entry);
      asking = true;
      const timer = setTimeout(() => { if (entry.state === "waiting") entry.state = "expired"; }, waitMs);
      timer.unref?.();
      void options.ask({ origin, code }).then((decision) => {
        if (entry.state !== "waiting") return;
        if (decision === "no") { entry.state = "denied"; return; }
        const key = randomBytes(32).toString("base64url");
        const hash = sha256(key);
        if (decision === "always") {
          const device: Device = { id: randomBytes(6).toString("hex"), kind: "site", label: origin, origin, keyHash: hash, createdAt: now() };
          options.store.add(device);
        } else once.add(hash);
        entry.key = key;
        entry.state = "allowed";
      }).catch(() => { if (entry.state === "waiting") entry.state = "denied"; }).finally(() => { asking = false; clearTimeout(timer); });
      return { ok: true, id, code, expiresIn: Math.round(waitMs / 1000) };
    },
    poll(id, origin) {
      const entry = pending.get(id);
      if (!entry || entry.origin !== origin) return undefined;
      if (entry.state === "waiting" && now() > entry.expires) entry.state = "expired";
      if (entry.state === "allowed" && !entry.taken) {
        entry.taken = true;
        return { state: "allowed", key: entry.key! };
      }
      return { state: entry.state };
    },
    accepts(key) {
      const hash = sha256(key);
      if (once.has(hash)) return true;
      const device = options.store.byKeyHash(hash);
      if (!device) return false;
      if (!device.lastUsed || now() - device.lastUsed > 60_000) options.store.touch(device.id, now());
      return true;
    },
  };
}
