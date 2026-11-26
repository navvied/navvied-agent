import { mkdtempSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const outsideFolder = (): string => realpathSync(mkdtempSync(join(homedir(), ".navvied-test-away-")));
