import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BROWSER_PROFILES, SECRET_DIRS, SECRET_FILES, isSecretPath } from "../secret-stores.ts";

/** What the person chose: whether commands are confined, and whether a confined command may use the network. */
export interface Setting { on: boolean; network: boolean }
export const DEFAULT_SETTING: Setting = { on: true, network: true };

/** What a confined command may write, and what it cannot see. Every path is real (links followed) and exists. */
export interface Plan { writable: string[]; hiddenDirs: string[]; hiddenFiles: string[] }

export interface PlanInput {
  /** The project folder. */
  root: string;
  home: string;
  /** The system's temporary folders. */
  tmp: readonly string[];
  /** Folders the program itself writes and a command may too (a conversation's attachments). */
  extra?: readonly string[];
  /** Files and folders of the program itself that hold keys. */
  hide?: readonly string[];
}

/** The folders programs keep what they download in: a command that installs something writes there, and failing would stop most of the work. */
const CACHES = [".cache", ".npm", ".bun", ".cargo", ".gradle", ".m2", ".nuget", ".deno", ".yarn", ".pnpm-store", ".local/share/pnpm", "go/pkg", "Library/Caches", "AppData/Local/npm-cache"];

const real = (p: string): string | undefined => { try { return realpathSync.native(p); } catch { return undefined; } };

export const within = (root: string, path: string): boolean => { const r = relative(root, path); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/** Where a project that is a linked worktree keeps its git data: outside the folder, and a commit writes there. */
function gitDirs(root: string): string[] {
  const dot = join(root, ".git");
  try {
    if (!lstatSync(dot).isFile()) return [];
    const line = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
    if (!line) return [];
    const dir = resolve(root, line);
    const common = (() => { try { return resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()); } catch { return undefined; } })();
    return [dir, ...(common ? [common] : [])];
  } catch { return []; }
}

/** The `.env` files of the folders above the project: a project's own are its own, the others are someone else's keys. */
function envFilesAbove(root: string, home: string): string[] {
  const found: string[] = [];
  const dirs = new Set<string>([home]);
  for (let d = dirname(root); d !== dirname(d); d = dirname(d)) dirs.add(d);
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) if (name.startsWith(".env") && isSecretPath(`/${name}`)) found.push(join(dir, name));
  }
  return found;
}

export function planFor(i: PlanInput): Plan {
  const root = real(i.root) ?? resolve(i.root);
  const home = real(i.home) ?? i.home;
  const writable = new Set<string>();
  const add = (p: string | undefined): void => { const r = p && real(p); if (r && r !== "/" && r !== dirname(r)) writable.add(r); };
  add(root);
  for (const g of gitDirs(root)) add(g);
  for (const t of i.tmp) add(t);
  for (const c of CACHES) add(join(home, c));
  for (const e of i.extra ?? []) add(e);
  // A folder inside another one that may be written is already covered.
  const writeRoots = [...writable].filter((w) => ![...writable].some((o) => o !== w && within(o, w)));

  const dirs = new Set<string>(), files = new Set<string>();
  const hide = (path: string): void => {
    const r = real(path);
    if (!r || within(r, root)) return;
    try { (lstatSync(r).isDirectory() ? dirs : files).add(r); } catch { /* it went away */ }
  };
  for (const name of [...SECRET_DIRS, ...BROWSER_PROFILES]) if (existsSync(join(home, name))) hide(join(home, name));
  for (const name of SECRET_FILES) if (existsSync(join(home, name))) hide(join(home, name));
  for (const f of envFilesAbove(root, home)) hide(f);
  for (const h of i.hide ?? []) hide(h);
  return { writable: writeRoots, hiddenDirs: [...dirs], hiddenFiles: [...files] };
}

/** A path as it is on the disk: the nearest folder that exists, followed through its links, with the rest kept. */
export function settle(path: string): string {
  let rest = "";
  let head = resolve(path);
  while (!existsSync(head) && head !== dirname(head)) { rest = join(head.slice(dirname(head).length + 1), rest); head = dirname(head); }
  return join(real(head) ?? head, rest);
}

export const allowsWrite = (plan: Plan, path: string): boolean => { const p = settle(path); return plan.writable.some((w) => within(w, p)) && !isHidden(plan, p); };
export const isHidden = (plan: Plan, path: string): boolean => { const p = settle(path); return plan.hiddenDirs.some((d) => within(d, p)) || plan.hiddenFiles.includes(p); };
