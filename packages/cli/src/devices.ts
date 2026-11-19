import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A website or a device the person has allowed to use this engine. Only a hash of its key is kept, never the key. */
export interface Device {
  id: string;
  kind: "site" | "relay";
  /** What the person sees in the list: the website, or the name of the device. */
  label: string;
  origin?: string;
  /** SHA-256 of the key given to a website. */
  keyHash?: string;
  /** The pairing secret of a relay device. The engine needs it to read that device's messages, so it is kept private on disk. */
  secret?: string;
  createdAt: number;
  /** The id this computer has on the navvied account it is connected to; set only on the device that stands for that connection. */
  account?: string;
  lastUsed?: number;
  /** A link was made for this device, but no device has joined it and been allowed on this computer yet. */
  pending?: boolean;
  /** When a pending link stops working, in milliseconds. */
  expires?: number;
}

const valid = (d: unknown): d is Device => {
  const x = d as Device;
  return typeof x === "object" && x !== null && typeof x.id === "string" && (x.kind === "site" || x.kind === "relay") && typeof x.label === "string" && typeof x.createdAt === "number";
};

/** The devices the person allowed, kept in a private file so they stay allowed the next time navvied starts. */
export class DeviceStore {
  #devices: Device[] = [];

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { devices?: unknown };
      if (Array.isArray(raw.devices)) this.#devices = raw.devices.filter(valid);
    } catch { /* no file yet, or it cannot be read: start empty */ }
  }

  list(): readonly Device[] { return this.#devices; }

  add(device: Device): void {
    this.#devices.push(device);
    this.#save();
  }

  remove(id: string): boolean {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter((d) => d.id !== id);
    if (this.#devices.length === before) return false;
    this.#save();
    return true;
  }

  update(id: string, change: Partial<Device>): void {
    const d = this.#devices.find((x) => x.id === id);
    if (!d) return;
    Object.assign(d, change);
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete (d as unknown as Record<string, unknown>)[k];
    this.#save();
  }

  byKeyHash(hash: string): Device | undefined { return this.#devices.find((d) => d.keyHash === hash); }

  touch(id: string, at: number): void {
    const d = this.#devices.find((x) => x.id === id);
    if (!d) return;
    d.lastUsed = at;
    this.#save();
  }

  #save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ devices: this.#devices }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* not supported on this system */ }
  }
}
