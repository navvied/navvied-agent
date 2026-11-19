import type { Choice } from "./io.ts";
import type { Device } from "./devices.ts";

/** "today", "yesterday", "5 days ago": when something last happened, in words. */
export function when(at: number | undefined, now: number): string {
  if (at === undefined) return "never";
  const days = Math.floor((now - at) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export interface DeviceRow extends Choice { id: string }

/** The list of websites and devices that may use this computer, newest use first. */
export function deviceRows(devices: readonly Device[], now: number): DeviceRow[] {
  return [...devices]
    .filter((d) => !d.pending)
    .sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt))
    .map((d) => ({ id: d.id, label: d.label, hint: `${d.kind === "site" ? "A website on this computer's address" : "A phone or another computer"}. Allowed ${when(d.createdAt, now)}, last used ${when(d.lastUsed, now)}.` }));
}
