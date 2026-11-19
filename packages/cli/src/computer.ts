import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { newSecret, toBase64Url } from "@navvied/protocol";
import type { Account } from "./account.ts";
import { connectComputer, disconnectComputer, renameComputer } from "./account-client.ts";
import type { DeviceStore } from "./devices.ts";

/** What people call this computer: the name they gave it in the system settings on a Mac, else the network name without its domain. */
export function computerName(platform: NodeJS.Platform = process.platform, run: (cmd: string, args: string[]) => string = (c, a) => { try { return spawnSync(c, a, { encoding: "utf8", timeout: 2000 }).stdout ?? ""; } catch { return ""; } }): string {
  const named = platform === "darwin" ? run("scutil", ["--get", "ComputerName"]).trim() : "";
  const full = hostname();
  const host = /^\d{1,3}(\.\d{1,3}){3}$/.test(full) ? "" : full.split(".")[0] ?? "";
  const plain = (n: string): boolean => n.length > 0 && !/^\d{1,3}(\.\d{1,3}){3}$/.test(n) && n !== "localhost";
  return plain(named) ? named : plain(host) ? host : "My computer";
}

/** The relay address that goes with an account's server: the same site, the path the relay answers on. */
export const relayUrlFor = (server: string): string => `${server.replace(/^http/, "ws").replace(/\/+$/, "")}/relay/ws`;

/**
 * Makes this computer one of the account's computers: it keeps a pairing secret of its own, tells the account, and keeps it as a
 * device that needs no question (the person is the same one who signed in here). Safe to repeat: it renews the same computer.
 * Returns true when the device is new or changed, so the caller knows to connect it to the relay.
 */
export async function connectThisComputer(send: typeof fetch, account: Account, devices: DeviceStore, name: string = computerName()): Promise<boolean> {
  const before = devices.list().find((d) => d.account !== undefined);
  const secret = before?.secret ?? toBase64Url(newSecret());
  const id = await connectComputer(send, account, name, secret, before?.account);
  if (before) {
    // A name that was only an address (how earlier versions called a computer) is replaced by the proper one; a name the person chose is left alone.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(before.label)) await renameComputer(send, account, id, name);
    devices.update(before.id, { account: id, label: /^\d{1,3}(\.\d{1,3}){3}$/.test(before.label) ? name : before.label });
    return false;
  }
  devices.add({ id: secret.slice(0, 10), kind: "relay", label: name, secret, account: id, createdAt: Date.now() });
  return true;
}

/** The computer leaves the account (signing out): the account forgets it and the secret is dropped here. */
export async function disconnectThisComputer(send: typeof fetch, account: Account, devices: DeviceStore, forget: (id: string) => void): Promise<void> {
  const mine = devices.list().find((d) => d.account !== undefined);
  if (!mine) return;
  await disconnectComputer(send, account, mine.account!);
  forget(mine.id);
}
