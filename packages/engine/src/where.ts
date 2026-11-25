import { homedir, tmpdir } from "node:os";
import type { Paths } from "./rules.ts";

/**
 * The home folder of the environment a program was given, not of the account that runs it: `HOME` (or `USERPROFILE`) wins over the account's own,
 * and `os.homedir()` does not follow a `HOME` that was set for this process on every runtime.
 */
export const homeFrom = (env: Readonly<Record<string, string | undefined>> = process.env): string => env.HOME || env.USERPROFILE || homedir();

/** `~`, `~/x`, `$HOME` and `${HOME}` at the start of a path, put in as the home folder; any other path as it was. */
export const expandHome = (path: string, home: string): string => path.replace(/^(~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => home.replace(/\\/g, "/").replace(/(.)\/+$/, "$1"));

/** The folders anyone may use as scratch space: a change or a look there is not a step outside the project. */
export const tempDirs = (): string[] => [tmpdir(), "/tmp", "/var/tmp", "/dev/shm"];

/** The null device and its kin: no one's place. */
const DEVICE = /^\/dev\/(null|zero|stdout|stderr|tty)$/;

const inside = (root: string, full: string, p: Paths): boolean => { const r = p.relative(p.resolve(root), full); return r !== ".." && !r.startsWith(`..${p.sep}`) && !r.startsWith("../") && !p.isAbsolute(r); };

/**
 * The one place that says whether a path is outside the project: not under the working folder, not in scratch space, not a device. `~` is the home of
 * the environment the program was given (`p.home`). A path with an expansion that is not known (`$X`, a substitution) cannot be shown to be inside, so it is outside.
 */
export function outsideProject(target: string, cwd: string, p: Paths, extra: readonly string[] = []): boolean {
  const t = expandHome(target.replace(/\\/g, "/"), p.home ?? homeFrom());
  if (!t || DEVICE.test(t)) return false;
  if (/[$`]/.test(t) || (p.sep === "/" && /^[a-z]:\//i.test(t))) return true;
  const full = p.resolve(cwd, t);
  return ![cwd, ...tempDirs(), ...extra].some((root) => inside(root, full, p));
}
