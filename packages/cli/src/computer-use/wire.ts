import { dirname, join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { pluginStatePath } from "../config.ts";
import type { IO } from "../io.ts";
import { PluginState } from "../plugins.ts";
import { rowOf } from "../tool-table.ts";
import { switchRow, toolId } from "../tools-info.ts";
import { type Grants, macGrants, noGrants } from "./grants.ts";
import { ComputerHere } from "./port.ts";
import { ComputerUse } from "./service.ts";
import { probeStatus, run, spawnChild } from "./system.ts";

export interface Wired { port: ComputerHere; setup(tell: (e: EngineEvent) => void): Promise<void> }

const UNREADABLE: Grants = { state: () => "missing", ask: () => undefined, settings: () => undefined };

export function computerWire(i: { io: IO; changed: () => void; unavailable: () => string | undefined; open: (url: string) => void; platform?: string; grants?: typeof macGrants }): Wired {
  const platform = i.platform ?? process.platform;
  const state = () => new PluginState(pluginStatePath(i.io.env));
  let grants: Grants = noGrants;
  const grantsRead: Promise<void> = platform === "darwin" ? (i.grants ?? macGrants)(i.open).then((read) => { grants = read; }, () => { grants = UNREADABLE; }) : Promise.resolve();
  const use = new ComputerUse({
    platform, arch: process.arch, env: i.io.env, dir: join(dirname(pluginStatePath(i.io.env)), "computer"), fetchFn: fetch, run, spawn: spawnChild, probe: probeStatus, pid: process.pid,
    ownApps: ["navvied"],
  });
  const row = rowOf("computer")!;
  const reason = (): string | undefined => i.unavailable();
  const port = new ComputerHere({
    use, grantsRead, grants: { state: (id) => grants.state(id), ask: (id) => { grants.ask(id); }, settings: (id) => { grants.settings(id); } },
    isOn: () => { const s = state(); return s.enabledExplicitly().has(toolId(row.id)) && !s.disabled().has(toolId(row.id)); },
    setOn: (on) => { switchRow(state(), row, on); },
    changed: i.changed,
    get unavailable() { return reason(); },
  });
  void port.state().catch(() => undefined);
  return { port, setup: (tell) => port.setup(tell) };
}
