import { homedir, tmpdir } from "node:os";
import type { Paths } from "./rules.ts";
import { isSecretPath } from "./secret-stores.ts";

/** Places that are not the project but are no one's: the null device and the computer's own scratch folder. */
const DEVICE = /^\/dev\/(null|zero|stdout|stderr|tty)$/;

/** Whether a place is outside the project (and not scratch space). A path with an expansion that is not known is outside: it cannot be shown to be inside. */
export function away(target: string, cwd: string, p: Paths): boolean {
  const t = target.replace(/\\/g, "/").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, (process.env.HOME || homedir()).replace(/\\/g, "/"));
  if (!t || DEVICE.test(t)) return false;
  if (/[$`]/.test(t) || (p.sep === "/" && /^[a-z]:\//i.test(t))) return true;
  const full = p.resolve(cwd, t);
  const inside = (root: string): boolean => { const r = p.relative(p.resolve(root), full); return r !== ".." && !r.startsWith(`..${p.sep}`) && !r.startsWith("../") && !p.isAbsolute(r); };
  return !inside(cwd) && !inside(tmpdir());
}

/** Files that keep keys and passwords: a shell's, a cloud's, a person's. An example file for one is not. */
export const secret = isSecretPath;
