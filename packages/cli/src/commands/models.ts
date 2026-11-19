import type { Options } from "../args.ts";
import { configPath, loadConfig } from "../config.ts";
import type { IO } from "../io.ts";
import { EXIT } from "./run.ts";

export function modelsCommand(options: Options, io: IO): number {
  const path = configPath(io.env, options.config);
  const file = loadConfig(path, io.env);
  if (!file.ok) { io.stderr.write(`error: ${file.error}\n`); return EXIT.usage; }
  const names = Object.keys(file.value?.models ?? {});
  if (!file.value || !names.length) {
    io.stdout.write("No model connected yet.\nRun navvied init to connect one.\n");
    return EXIT.ok;
  }
  for (const name of names) {
    const m = file.value.models[name]!;
    const marker = name === file.value.default ? "*" : " ";
    const where = m.command ? `command: ${[m.command, ...(m.args ?? [])].join(" ")}` : `${m.model}  ${m.baseUrl}`;
    io.stdout.write(`${marker} ${name}  ${where}  ${(m.window ?? 128_000).toLocaleString("en-US")} tokens\n`);
  }
  return EXIT.ok;
}
