import { dirname, join } from "node:path";
import { pluginStatePath } from "../../cli/src/config.ts";
import { PluginState } from "../../cli/src/plugins.ts";

const HERE = dirname(import.meta.path);
export const TASKS = join(HERE, "../tasks");
export const CLI = join(HERE, "../../cli/src/main.ts");

/** The values of `--name x` and `--name=x` in an argument list, in order. */
export function option(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === `--${name}` && args[i + 1]) out.push(args[i + 1]!); else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3)); });
  return out;
}

/** What an agent run is given so that a scripted or counted model is reached by address, in a home of its own: the person's own configuration is not used. */
export const agentWorld = (home: string, model: string, window: number, key?: string, api?: string): Record<string, string> => ({ HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home, NAVVIED_MODEL: model, NAVVIED_WINDOW: String(window), ...(key ? { NAVVIED_API_KEY: key } : {}), ...(api ? { NAVVIED_API: api } : {}) });

/** Switches the code tool on in the agent's own home (the same switch a person uses), or leaves it off: the two arms of a comparison run the same program. */
export function codeTool(world: Record<string, string>, on: boolean): void {
  const state = new PluginState(pluginStatePath(world));
  if (on) state.set("tool:code", true); else state.forget("tool:code");
}
