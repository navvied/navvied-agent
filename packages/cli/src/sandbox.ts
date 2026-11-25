import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SANDBOX, sandboxAbility, type SandboxSetting } from "@navvied/engine";
import type { SandboxInfo } from "@navvied/protocol";
import type { ConfigFile } from "./config.ts";

/** What the person chose on the settings screen, kept in the computer's own state. A choice not made is absent, and the configuration decides. */
export class SandboxState {
  constructor(private readonly file: string) {}
  get(): Partial<SandboxSetting> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { on?: unknown; network?: unknown };
      return { ...(typeof raw.on === "boolean" ? { on: raw.on } : {}), ...(typeof raw.network === "boolean" ? { network: raw.network } : {}) };
    } catch { return {}; }
  }
  set(change: Partial<SandboxSetting>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, ...this.get(), ...change }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }
}

/** The setting in force: the person's choice, else the configuration (`"sandbox": "off"` or `{ "network": false }`), else the default. */
export function sandboxSetting(state: SandboxState, config: ConfigFile["sandbox"]): SandboxSetting {
  const base: Partial<SandboxSetting> = config === "off" ? { on: false } : config === "on" ? { on: true } : config && typeof config === "object" && config.network !== undefined ? { network: config.network } : {};
  return { ...DEFAULT_SANDBOX, ...base, ...state.get() };
}

/** What a settings screen shows: the setting and whether this computer can confine commands at all, with the reason when it cannot. */
export function sandboxInfo(setting: SandboxSetting, platform: NodeJS.Platform = process.platform): SandboxInfo {
  const a = sandboxAbility(platform);
  return { on: setting.on, network: setting.network, how: a.how, ...(a.why ? { why: a.why } : {}) };
}
