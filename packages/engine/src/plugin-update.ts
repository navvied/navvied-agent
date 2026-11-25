/**
 * Updating plugins. An update fetches the plugin again from where it was installed from (kept in the lock file), says what changed, and
 * installs the new version only when the person gives the new fingerprint. Until then nothing is touched: the old copy stays, and so does
 * the lock file. Checking for a new version installs nothing, and a source on the network is only asked when the caller says so.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PluginLock, discard, readPack, readTree, stagePlugin, swapIn, type Entry, type Pack, type Run } from "./plugin-pack.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHOWN = 50;

export interface PluginChange {
  name: string;
  from: { version: string; hash: string };
  to: { version: string; hash: string };
  /** Files, with their folder, at most 50 each. */
  added: string[];
  removed: string[];
  changed: string[];
  /** Commands the new version would run that the old one did not, with what reading them found. */
  newRuns: Run[];
  /** Hook events the new version listens to that the old one did not. */
  newEvents: string[];
  /** Skills, helpers and commands it now brings that it did not. */
  newBrings: { skills: string[]; agents: string[]; commands: string[] };
}

export type UpdateResult = { ok: true; change: PluginChange; installed: boolean; pack: Pack } | { ok: false; error: string };

const digests = (entries: readonly Entry[]): Map<string, string> => new Map(entries.map((e) => [e.rel, createHash("sha256").update(e.data).digest("hex")]));
const events = (p: Pack): string[] => Object.keys(p.hooks);
const key = (r: Run): string => `${r.what}\0${r.command}`;
const fresh = (now: readonly string[], before: readonly string[]): string[] => now.filter((n) => !before.includes(n));

/** What differs between the installed plugin (as it is on disk) and the new one. */
export function diffPlugins(oldDir: string, old: Pack, next: Pack, lockHash: string): PluginChange {
  const a = readTree(oldDir), b = readTree(next.dir);
  const before = digests("entries" in a ? a.entries : []), after = digests("entries" in b ? b.entries : []);
  const names = (list: string[]): string[] => list.sort().slice(0, SHOWN);
  const oldRuns = new Set(old.runs.map(key));
  return {
    name: next.name,
    from: { version: old.version, hash: lockHash },
    to: { version: next.version, hash: next.hash },
    added: names([...after.keys()].filter((f) => !before.has(f))),
    removed: names([...before.keys()].filter((f) => !after.has(f))),
    changed: names([...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f))),
    newRuns: next.runs.filter((r) => !oldRuns.has(key(r))),
    newEvents: fresh(events(next), events(old)),
    newBrings: { skills: fresh(next.skills, old.skills), agents: fresh(next.agents, old.agents), commands: fresh(next.commands, old.commands) },
  };
}

export interface UpdateOptions {
  name: string;
  /** The folder the person's plugins are in. */
  root: string;
  lock: PluginLock;
  /** The new fingerprint the person accepted (at least 12 hex digits). Without it nothing is installed. */
  accept?: string;
  fetch?: typeof fetch;
}

/** Fetches the plugin again from its source and reports the change; installs it only when `accept` is the new fingerprint. */
export async function updatePlugin(o: UpdateOptions): Promise<UpdateResult> {
  if (!NAME.test(o.name)) return { ok: false, error: "there is no installed plugin with that name" };
  const entry = o.lock.read()[o.name];
  if (!entry) return { ok: false, error: "there is no installed plugin with that name" };
  const got = await stagePlugin({ from: entry.source, root: o.root, ...(o.accept ? { expectHash: o.accept } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  if (!got.ok) return got;
  try {
    if (got.pack.name !== o.name) return { ok: false, error: `${entry.source} now brings a plugin called ${got.pack.name}, not ${o.name}` };
    const target = join(o.root, o.name);
    const change = diffPlugins(target, readPack(target, "user"), got.pack, entry.hash);
    if (!o.accept || got.pack.hash === entry.hash) return { ok: true, change, installed: false, pack: got.pack };
    swapIn(got, target);
    o.lock.set(o.name, { hash: got.pack.hash, version: got.pack.version, source: entry.source });
    return { ok: true, change, installed: true, pack: { ...got.pack, dir: target } };
  } finally { discard(got); }
}

export interface OutdatedRow {
  name: string;
  version: string;
  origin: string;
  /** `current`: same files as installed. `newer`: the source has other files. `not-asked`: the source is on the network and the caller did not ask. `unreachable`: the source could not be read. */
  status: "current" | "newer" | "not-asked" | "unreachable";
  latest?: string;
  why?: string;
}

/** A source that needs the network to be read: a web address, or git over anything but a local `file://`. */
export const isRemote = (source: string): boolean => /^(https?|ssh|git):\/\//i.test(source) || /^git@/i.test(source);

/** For each installed plugin: whether its source now has other files. Nothing is installed; a source on the network is read only with `online`. */
export async function checkOutdated(o: { root: string; lock: PluginLock; online?: boolean; fetch?: typeof fetch; only?: string }): Promise<OutdatedRow[]> {
  const rows: OutdatedRow[] = [];
  for (const [name, entry] of Object.entries(o.lock.read()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (o.only && o.only !== name) continue;
    const row = { name, version: entry.version, origin: entry.source };
    if (isRemote(entry.source) && !o.online) { rows.push({ ...row, status: "not-asked" }); continue; }
    const got = await stagePlugin({ from: entry.source, root: o.root, ...(o.fetch ? { fetch: o.fetch } : {}) });
    if (!got.ok) { rows.push({ ...row, status: "unreachable", why: got.error }); continue; }
    rows.push(got.pack.hash === entry.hash ? { ...row, status: "current" } : { ...row, status: "newer", latest: got.pack.version });
    discard(got);
  }
  return rows;
}
