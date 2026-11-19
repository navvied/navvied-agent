import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { detectMachine, isInstalledProgram, releaseBase, updateProgram, type Machine } from "./update.ts";

/** Checks closer together than this are skipped, so several open windows do not all ask at once. */
const MIN_GAP = 5 * 60 * 1000;

export interface AutoUpdateOptions {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** The installed program; a program run from source is never touched. */
  exe: string;
  /** Where the time of the last check is remembered. */
  stamp: string;
  /** Turned off in the configuration file. */
  enabled?: boolean;
  now?: () => number;
  machine?: Machine;
}

/** Check for a newer release and install it in the background. Only a small checksum file is fetched unless something changed. Never throws. */
export async function autoUpdate(o: AutoUpdateOptions): Promise<"updated" | "current" | "skipped"> {
  if (o.enabled === false || o.env.NAVVIED_NO_UPDATE || !isInstalledProgram(o.exe)) return "skipped";
  const now = (o.now ?? Date.now)();
  const last = existsSync(o.stamp) ? Number(readFileSync(o.stamp, "utf8")) : 0;
  if (Number.isFinite(last) && now - last < MIN_GAP) return "skipped";
  try {
    mkdirSync(dirname(o.stamp), { recursive: true });
    writeFileSync(o.stamp, String(now));
    return await updateProgram({ ...(o.machine ?? detectMachine()), base: releaseBase(o.env), exe: o.exe, fetch: o.fetch });
  } catch { return "skipped"; }
}
