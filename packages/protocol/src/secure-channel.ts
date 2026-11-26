
type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export const SECRET_BYTES = 32;
export const MOST_WATCHED = 16;
const NONCE_BYTES = 12;
const SESSION_BYTES = 8;
const HEADER = SESSION_BYTES + 8;
const MAX_SESSIONS = 64;

export type Role = "engine" | "client";

export function toBase64Url(bytes: Bytes): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const newSecret = (): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));

export interface Pairing {
  channel: string;
  proof: string;
  proofHash: string;
  key: CryptoKey;
}

async function derive(secret: Bytes, info: string, bytes: number): Promise<Bytes> {
  const base = await subtle().importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(`navvied relay v1 ${info}`) }, base, bytes * 8);
  return new Uint8Array(bits);
}

export const hashProof = async (proof: string): Promise<string> =>
  toBase64Url(new Uint8Array(await subtle().digest("SHA-256", fromBase64Url(proof))));

export async function pairingFrom(secret: Bytes): Promise<Pairing> {
  if (secret.length !== SECRET_BYTES) throw new Error("the pairing secret has the wrong length");
  const [channel, proof, key] = await Promise.all([derive(secret, "channel", 16), derive(secret, "proof", 32), derive(secret, "key", 32)]);
  return {
    channel: toBase64Url(channel),
    proof: toBase64Url(proof),
    proofHash: await hashProof(toBase64Url(proof)),
    key: await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]),
  };
}

const be64 = (n: number): Bytes => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(n)); return out; };
const readBe64 = (b: Bytes): number => Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0));
const aad = (channel: string, from: Role): Bytes => enc.encode(`${from}:${channel}`);

export class Sealer {
  readonly #session = globalThis.crypto.getRandomValues(new Uint8Array(SESSION_BYTES));
  #seq = 0;
  constructor(private readonly pairing: Pairing, private readonly from: Role) {}

  async seal(text: string): Promise<string> {
    const body = enc.encode(text);
    const plain = new Uint8Array(HEADER + body.length);
    plain.set(this.#session, 0);
    plain.set(be64(++this.#seq), SESSION_BYTES);
    plain.set(body, HEADER);
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const sealed = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(this.pairing.channel, this.from) }, this.pairing.key, plain));
    const out = new Uint8Array(NONCE_BYTES + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, NONCE_BYTES);
    return toBase64Url(out);
  }
}

export class Opener {
  readonly #last = new Map<string, number>();
  constructor(private readonly pairing: Pairing, private readonly from: Role) {}

  async open(message: string): Promise<string> {
    let raw: Bytes;
    try { raw = fromBase64Url(message); } catch { throw new Error("not a sealed message"); }
    if (raw.length < NONCE_BYTES + HEADER + 16) throw new Error("not a sealed message");
    let plain: Bytes;
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: raw.slice(0, NONCE_BYTES), additionalData: aad(this.pairing.channel, this.from) }, this.pairing.key, raw.slice(NONCE_BYTES)));
    } catch { throw new Error("could not open the message"); }
    const session = toBase64Url(plain.slice(0, SESSION_BYTES));
    const seq = readBe64(plain.slice(SESSION_BYTES, HEADER));
    if (seq <= (this.#last.get(session) ?? 0)) throw new Error("repeated or out of order message");
    this.#last.delete(session);
    this.#last.set(session, seq);
    if (this.#last.size > MAX_SESSIONS) this.#last.delete(this.#last.keys().next().value as string);
    return dec.decode(plain.slice(HEADER));
  }
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export async function pairingCode(secret: Bytes): Promise<string> {
  const bytes = await derive(secret, "code", 8);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export const pairingLink = (site: string, secret: Bytes): string => `${site.replace(/\/+$/, "")}/#relay=${toBase64Url(secret)}`;

export function secretFromLink(hash: string): Bytes | undefined {
  const found = /(?:^|[#&])relay=([A-Za-z0-9_-]+)/.exec(hash)?.[1];
  if (!found) return undefined;
  try { const secret = fromBase64Url(found); return secret.length === SECRET_BYTES ? secret : undefined; } catch { return undefined; }
}
