/**
 * Every test process starts in a folder of its own, not in the repository. A program that runs "here" (the command line with no folder given, an engine
 * started with the current folder) then works on a scratch folder instead of on the checkout it is being tested in: no checkpoint, no file, no
 * repository change reaches the real one. A test that needs the repository names it from its own place (`import.meta.dir`).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "navvied-test-cwd-")));
process.chdir(scratch);
process.on("exit", () => { try { process.chdir(tmpdir()); rmSync(scratch, { recursive: true, force: true }); } catch { /* a leftover temp folder */ } });
