// Cuts a report into files of at most `size` characters, each ending at the end of a line, so a CI step can show each as one annotation.
//   bun split-report.ts <report> <folder> [size]   writes <folder>/part.00, part.01, ...
import { readFileSync, writeFileSync } from "node:fs";

const [, , report, folder, size = "3500"] = process.argv;
const limit = Number(size);
let part = 0, chunk = "";
const flush = () => { if (chunk) { writeFileSync(`${folder}/part.${String(part).padStart(2, "0")}`, chunk); part++; chunk = ""; } };
for (const line of readFileSync(report!, "utf8").split(/(?<=\n)/)) {
  if (chunk.length + line.length > limit) flush();
  chunk += line.slice(0, limit);
}
flush();
