#!/usr/bin/env bun
/** What `navvied guard` does when it is started by an engine: ask it, and say what it answered. */
import { askEngine } from "../src/index.ts";

const answer = await askEngine(process.env, await Bun.stdin.text());
process.stdout.write(answer.stdout);
process.stderr.write(answer.stderr);
process.exit(answer.code);
