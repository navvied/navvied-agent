/**
 * Lets a page on another device use the engine on this computer, through the relay. This computer connects out to the relay
 * once per paired device; the relay passes sealed messages and cannot read them. Each device holds one secret, made here and
 * shared in a link, from which the channel, the proof and the key are derived (see the protocol package).
 */
import { Opener, Sealer, fromBase64Url, newSecret, pairingCode, pairingFrom, pairingLink, toBase64Url, type Pairing } from "@navvied/protocol";
import type { Hub } from "./commands/hub.ts";
import type { Device, DeviceStore } from "./devices.ts";
import type { Decision } from "./pairing.ts";

export interface SocketLike {
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(text: string): void;
  close(): void;
}

export interface RelayHostOptions {
  /** The relay's WebSocket address, such as wss://navvied.com/relay/ws. */
  url: string;
  /** The website the pairing link opens. */
  site: string;
  hub: Hub;
  store: DeviceStore;
  /** Asks the person whether a device that just joined a new link may use this computer. `id` is that device's, for a caller (such as a shell with no terminal of its own) that must later match an answer, or a `forget`, back to the question it belongs to. */
  ask(question: { id: string; origin: string; code: string }): Promise<Decision>;
  now?: () => number;
  open?: (url: string) => SocketLike;
  /** How long a new link works before anyone joins it, in milliseconds. */
  pendingMs?: number;
  /** The wait before trying the relay again: the first and the longest, in milliseconds. */
  backoffMs?: [number, number];
  /** How often to say hello to the relay so it does not hang up, in milliseconds. */
  pingMs?: number;
  /** Called when another navvied took this device's place on the relay, so the person can be told. */
  replaced?: (device: Device) => void;
}

interface Peer {
  sealer: Sealer;
  opener: Opener;
  attached: (() => void) | undefined;
  /** Messages are opened and answered one after another, because each is numbered. */
  queue: Promise<void>;
  asked: boolean;
}

/** The relay's close code for "another engine joined this channel". */
const REPLACED = 4000;

const HELLO_WAIT = "The device is waiting to be allowed on the computer.";

/** A connection with nothing arriving at all, for this many of its own ping intervals, is given up on sooner than a dead TCP socket otherwise would be noticed. */
const DEAD_AFTER_PINGS = 2.5;

class Link {
  #socket: SocketLike | undefined;
  #peers = new Map<number, Peer>();
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ping: ReturnType<typeof setInterval> | undefined;
  #delay: number;
  #approved: boolean;
  #ephemeral = false;
  /** The last time anything at all arrived on this connection: a ping that the relay never answers is a connection gone quiet, not one still there. */
  #lastSeen = 0;
  ready = false;

  constructor(private readonly host: RelayHost, readonly device: Device, private readonly pairing: Pairing, private readonly code: string) {
    this.#delay = host.backoff[0];
    this.#approved = device.pending !== true;
  }

  connect(): void {
    if (this.#stopped) return;
    const socket = this.host.open(this.host.url);
    this.#socket = socket;
    this.#lastSeen = this.host.now();
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: "hello", role: "engine", c: this.pairing.channel, h: this.pairing.proofHash }));
      this.#ping = setInterval(() => {
        if (this.host.now() - this.#lastSeen > this.host.pingMs * DEAD_AFTER_PINGS) { try { socket.close(); } catch { /* already closing */ } return; }
        try { socket.send(JSON.stringify({ t: "ping" })); } catch { /* closing */ }
      }, this.host.pingMs);
      (this.#ping as { unref?: () => void }).unref?.();
    };
    socket.onmessage = (e) => { this.#lastSeen = this.host.now(); this.#message(String(e.data)); };
    socket.onclose = (e) => this.#closed(socket, (e as { code?: number } | undefined)?.code);
    socket.onerror = () => undefined;
  }

  stop(): void {
    this.#stopped = true;
    this.ready = false;
    clearTimeout(this.#timer);
    clearInterval(this.#ping);
    for (const peer of this.#peers.values()) peer.attached?.();
    this.#peers.clear();
    try { this.#socket?.close(); } catch { /* already closed */ }
    if (this.#ephemeral) this.host.store.remove(this.device.id);
  }

  #closed(socket: SocketLike, code?: number): void {
    if (socket !== this.#socket) return;
    clearInterval(this.#ping);
    this.ready = false;
    for (const peer of this.#peers.values()) peer.attached?.();
    this.#peers.clear();
    if (this.#stopped) return;
    // Another navvied took this device's place. Taking it back would start a tug of war that cuts both off, every second.
    if (code === REPLACED) { this.#stopped = true; this.host.replaced(this.device); return; }
    this.#timer = setTimeout(() => this.connect(), this.#delay);
    (this.#timer as { unref?: () => void }).unref?.();
    this.#delay = Math.min(this.#delay * 2, this.host.backoff[1]);
  }

  #addPeer(id: number): void {
    if (this.#peers.has(id)) return;
    this.#peers.set(id, { sealer: new Sealer(this.pairing, "engine"), opener: new Opener(this.pairing, "client"), attached: undefined, queue: Promise.resolve(), asked: false });
  }

  #send(value: object): void { try { this.#socket?.send(JSON.stringify(value)); } catch { /* the relay is gone; the close is handled */ } }

  #message(text: string): void {
    let msg: { t?: string; id?: number; up?: boolean; from?: number; d?: string; code?: string };
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === "ready") {
      this.ready = true;
      this.#delay = this.host.backoff[0];
      void this.host.hub.refreshModels();
      // Pages that were already waiting when this computer joined are told about now, as if they had just arrived.
      for (const id of Array.isArray((msg as { clients?: unknown }).clients) ? ((msg as { clients: unknown[] }).clients.filter((c): c is number => typeof c === "number")) : []) this.#addPeer(id);
      return;
    }
    if (msg.t === "peer" && typeof msg.id === "number") {
      if (msg.up === true) this.#addPeer(msg.id);
      else { this.#peers.get(msg.id)?.attached?.(); this.#peers.delete(msg.id); }
      return;
    }
    if (msg.t === "d" && typeof msg.from === "number" && typeof msg.d === "string") {
      const peer = this.#peers.get(msg.from);
      if (!peer) return;
      const sealed = msg.d;
      peer.queue = peer.queue.then(() => this.#receive(msg.from!, peer, sealed)).catch(() => undefined);
    }
  }

  async #deliver(id: number, peer: Peer, value: string): Promise<void> {
    this.#send({ t: "d", to: id, d: await peer.sealer.seal(value) });
  }

  async #receive(id: number, peer: Peer, sealed: string): Promise<void> {
    let text: string;
    try { text = await peer.opener.open(sealed); } catch { return; }
    if (peer.attached) { this.host.hub.command(text, (reply) => { peer.queue = peer.queue.then(() => this.#deliver(id, peer, reply)).catch(() => undefined); }); return; }

    let hello: { navvied?: string; since?: unknown };
    try { hello = JSON.parse(text); } catch { return; }
    if (hello.navvied !== "hello") return;
    if (!this.#approved) {
      if (peer.asked) return;
      peer.asked = true;
      if (this.device.expires !== undefined && this.host.now() > this.device.expires) { this.host.forget(this.device.id); return; }
      const answer = await this.host.ask({ id: this.device.id, origin: `${this.device.label} (from another device)`, code: this.code });
      if (answer === "no") {
        await this.#deliver(id, peer, JSON.stringify({ ev: "error", msg: "It was not allowed on the computer." }));
        this.host.forget(this.device.id);
        return;
      }
      this.#approved = true;
      if (answer === "always") this.host.store.update(this.device.id, { pending: undefined, expires: undefined });
      else this.#ephemeral = true;
    }
    this.host.store.update(this.device.id, { lastUsed: this.host.now() });
    const since = typeof hello.since === "number" && hello.since > 0 ? hello.since : 0;
    // The page may have missed nothing, in which case nothing else would come: this tells it that it is connected.
    await this.#deliver(id, peer, JSON.stringify({ ev: "alive" }));
    peer.attached = this.host.hub.attach({ send: (line) => { peer.queue = peer.queue.then(() => this.#deliver(id, peer, line)).catch(() => undefined); } }, since);
  }
}

export class RelayHost {
  readonly url: string;
  readonly store: DeviceStore;
  readonly hub: Hub;
  readonly backoff: [number, number];
  readonly pingMs: number;
  readonly ask: RelayHostOptions["ask"];
  readonly replaced: (device: Device) => void;
  readonly #links = new Map<string, Link>();

  constructor(private readonly o: RelayHostOptions) {
    this.url = o.url;
    this.store = o.store;
    this.hub = o.hub;
    this.ask = o.ask;
    this.replaced = o.replaced ?? (() => undefined);
    this.backoff = o.backoffMs ?? [1000, 30_000];
    this.pingMs = o.pingMs ?? 25_000;
  }

  now(): number { return (this.o.now ?? Date.now)(); }
  open(url: string): SocketLike { return (this.o.open ?? ((u) => new WebSocket(u) as unknown as SocketLike))(url); }

  /** Connects to the relay for every device that was paired before. Links that nobody used in time are dropped. */
  async start(): Promise<void> {
    for (const device of this.store.list()) {
      if (device.kind !== "relay" || !device.secret || this.#links.has(device.id)) continue;
      if (device.pending && device.expires !== undefined && this.now() > device.expires) { this.store.remove(device.id); continue; }
      // A device whose secret cannot be read is of no use to anyone: it is dropped, and the others carry on.
      try { await this.#link(device); } catch { this.store.remove(device.id); }
    }
  }

  /** Makes a link for a new device, and starts waiting for it. */
  async pair(label: string): Promise<{ id: string; link: string; code: string; expiresInSeconds: number }> {
    const secret = newSecret();
    const window = this.o.pendingMs ?? 10 * 60_000;
    const device: Device = { id: toBase64Url(secret).slice(0, 10), kind: "relay", label, secret: toBase64Url(secret), createdAt: this.now(), pending: true, expires: this.now() + window };
    this.store.add(device);
    await this.#link(device);
    return { id: device.id, link: pairingLink(this.o.site, secret), code: await pairingCode(secret), expiresInSeconds: Math.round(window / 1000) };
  }

  /** How many devices the relay has told us it knows about right now. */
  get connected(): number { return [...this.#links.values()].filter((l) => l.ready).length; }

  forget(id: string): void {
    this.#links.get(id)?.stop();
    this.#links.delete(id);
    this.store.remove(id);
  }

  stop(): void {
    for (const link of this.#links.values()) link.stop();
    this.#links.clear();
  }

  async #link(device: Device): Promise<void> {
    const secret = fromBase64Url(device.secret!) as Uint8Array<ArrayBuffer>;
    const link = new Link(this, device, await pairingFrom(secret), await pairingCode(secret));
    this.#links.set(device.id, link);
    link.connect();
  }
}
