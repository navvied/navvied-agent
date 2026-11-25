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
  board: {
    Board: {
      start: "main",
      screens: {
        main: { tree: ['1 window "Board"', '2 card "Write release notes"', '3 column "Done"', '4 column "Todo"'], on: { "drag 2>3": "moved", "drag 2>4": "same" } },
        moved: { tree: ['1 window "Board"', '2 text "Write release notes moved to Done. Code {code:5}"'] },
        same: { tree: ['1 window "Board"', '2 text "Nothing changed."'] },
      },
    },
  },
  files: {
    Files: {
      start: "main",
      screens: {
        main: { tree: ['1 window "Files"', '2 file "report.txt"'], on: { "right click 2": "menu", "double click 2": "opened", "click 2": "selected" } },
        menu: { tree: ['1 menu "report.txt"', '2 item "Properties"', '3 item "Delete"'], on: { "click 2": "properties", "click 3": "deleted" } },
        properties: { tree: ['1 window "Properties"', '2 text "report.txt, 4 KB. Code {code:6}"'] },
        opened: { tree: ['1 window "Editor"', '2 text "report.txt is open."'] },
        selected: { tree: ['1 window "Files"', '2 file "report.txt" (selected)'] },
        deleted: { tree: ['1 text "report.txt was deleted."'] },
      },
    },
  },
  gallery: {
    Rows: {
      start: "main",
      screens: {
        main: { tree: ['1 window "Rows"', '2 row "Alpha"', '3 row "Beta"', '4 row "Gamma"'], on: { "click 2": "first", "click 4": "only" } },
        first: { tree: ['1 window "Rows"', '2 row "Alpha" (selected)', '3 row "Beta"', '4 row "Gamma"'], on: { "click 4+shift": "range", "click 4": "only" } },
        range: { tree: ['1 window "Rows"', '2 text "3 rows selected. Code {code:7}"'] },
        only: { tree: ['1 window "Rows"', '2 text "1 row selected."'] },
      },
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
