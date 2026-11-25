import type { Paths } from "./rules.ts";
import { isSecretPath } from "./secret-stores.ts";
import { outsideProject } from "./where.ts";

/** Whether a place is outside the project and not scratch space. */
export const away = (target: string, cwd: string, p: Paths): boolean => outsideProject(target, cwd, p);

/** Files that keep keys and passwords: a shell's, a cloud's, a person's. An example file for one is not. */
export const secret = isSecretPath;
