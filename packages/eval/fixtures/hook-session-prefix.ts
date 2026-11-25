/** A SessionStart hook for the offline hook tasks: tells the agent the commit message prefix of this project, which only this run's hook knows. */
import { createHash } from "node:crypto";
const prefix = createHash("sha1").update(`${process.env.BENCH_SECRET ?? ""}prefix`).digest("hex").slice(0, 8);
console.log(`Commit messages in this project start with "${prefix}: " (lower case, no full stop).`);
