#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { updateFiles } from "./release-assets.ts";

const [, , tag] = process.argv;
if (!tag?.startsWith("v")) throw new Error("usage: assemble-update-manifest.ts <tag, e.g. v0.2.0>, run in the folder that holds the release files");
const version = tag.slice(1);
const base = `https://github.com/navvied/navvied-agent/releases/download/${tag}`;

const files = Object.entries(updateFiles(version));
const absent = files.flatMap(([, f]) => [f, `${f}.sig`]).filter((f) => !existsSync(f));
if (absent.length) throw new Error(`latest.json needs every system's signed update file; missing: ${absent.join(", ")}`);

const platforms = Object.fromEntries(files.map(([system, f]) => [system, { signature: readFileSync(`${f}.sig`, "utf8").trim(), url: `${base}/${f}` }]));
writeFileSync("latest.json", `${JSON.stringify({ version, notes: "See the release notes.", pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(readFileSync("latest.json", "utf8"));
