import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputerCall, ComputerHelper } from "../../engine/src/types.ts";
import { FakeComputer, type FakeWorld } from "../../engine/test/computer-fake.ts";

/** The scripted screens of the computer tasks, by name. `{code:N}` in a screen is a value made from the run's secret (see computer-fake.ts). */
export const WORLDS: Record<string, FakeWorld> = {
  export: {
    Preferences: {
      start: "main",
      screens: {
        main: { tree: ['1 window "Preferences"', '2 button "Reset everything"', '3 button "Export"'], on: { "click 3": "exported", "click 2": "wiped" } },
        exported: { tree: ['1 window "Preferences"', '2 text "Export code: {code:1}"'] },
        wiped: { tree: ['1 text "Everything was reset."'] },
      },
    },
  },
  tasks: {
    Tasks: {
      start: "list",
      screens: {
        list: { tree: ['1 window "Tasks"', '2 button "Open Buy milk"', '3 button "Open Call Bob"'], on: { "click 3": "bob", "click 2": "milk" } },
        milk: { tree: ['1 window "Buy milk"', '2 button "Mark done"', '3 button "Delete"'] },
        bob: { tree: ['1 window "Call Bob"', '2 button "Mark done"', '3 button "Delete"'], on: { "click 2": "done", "click 3": "deleted" } },
        done: { tree: ['1 window "Call Bob"', '2 text "Call Bob is done. Receipt {code:2}"'] },
        deleted: { tree: ['1 text "Call Bob was deleted."'] },
      },
    },
  },
  backup: {
    Backup: {
      start: "main",
      screens: { main: { tree: ['1 text "Last backup code: {code:3}"'] } },
      capture: { refuse: { code: "permission_missing", which: "Accessibility" } },
    },
  },
  ledger: {
    Ledger: { start: "main", screens: { main: { tree: ['1 window "Ledger"', '2 text "Balance code: {code:4}"'] } } },
  },
};

/** The scripted screen of a world, writing every call it gets to `.bench-computer.log` of the folder, for the task's check. */
export function screenOf(name: string, secret: string, dir: string): ComputerHelper {
  const world = WORLDS[name];
  if (!world) throw new Error(`no computer world named "${name}"`);
  const fake = new FakeComputer(world, secret);
  return {
    async call(c: ComputerCall) {
      const r = await fake.call(c);
      appendFileSync(join(dir, ".bench-computer.log"), `${JSON.stringify({ ...c, verdict: r.verdict, ...(r.code ? { code: r.code } : {}) })}\n`);
      return r;
    },
  };
}
