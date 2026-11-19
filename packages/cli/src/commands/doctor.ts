import { mkdirSync } from "node:fs";
import type { Options } from "../args.ts";
import { configPath, loadConfig, resolveModel, sessionsDir } from "../config.ts";
import type { IO } from "../io.ts";
import { reachable } from "./init.ts";
import { EXIT } from "./run.ts";

export async function doctorCommand(options: Options, io: IO): Promise<number> {
  let problems = 0;
  const line = (ok: boolean | "note", name: string, detail: string): void => {
    if (ok === false) problems += 1;
    io.stderr.write(`${ok === true ? "✓" : ok === "note" ? "·" : "✗"} ${name.padEnd(9)} ${detail}\n`);
  };

  const path = configPath(io.env, options.config);
  const file = loadConfig(path, io.env);
  if (!file.ok) { line(false, "config", file.error); return EXIT.failed; }
  const count = Object.keys(file.value?.models ?? {}).length;
  line(file.value ? true : "note", "config", file.value ? `${path} (${count} model${count === 1 ? "" : "s"})` : "no model connected yet; run navvied init to connect one");

  const model = resolveModel(options.model, file.value, io.env, path);
  if (!model.ok) line(false, "model", model.error);
  else if (model.value.cli) {
    const found = Bun.which(model.value.cli.command, { PATH: io.env.PATH ?? "" });
    line(Boolean(found), "model", found ? `${model.value.name}: runs ${found}` : `${model.value.name}: "${model.value.cli.command}" is not on your PATH`);
  } else {
    const p = model.value.provider!;
    const ok = await reachable({ baseUrl: p.baseUrl, ...(model.value.api ? { api: model.value.api } : {}), model: p.model, ...(p.apiKey ? { apiKey: p.apiKey } : {}) }, io.env, io.fetch);
    line(ok, "model", ok ? `${model.value.name}: ${p.baseUrl} answered` : `${model.value.name}: ${p.baseUrl} did not answer (is it running, and is the key right?)`);
    if (model.value.api !== "ollama" && /:11434(\/|$)/.test(p.baseUrl)) line(false, "memory", "Ollama keeps only 4096 tokens of a conversation through this address, and drops the rest without saying so. Open navvied, type /model, and choose the model again.");
  }

  const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
  line(git.exitCode === 0 ? true : "note", "git", git.exitCode === 0 ? git.stdout.toString().trim() : "not found: checkpoints need git");

  try { mkdirSync(sessionsDir(io.env), { recursive: true }); line(true, "storage", sessionsDir(io.env)); }
  catch { line(false, "storage", `cannot write to ${sessionsDir(io.env)}`); }

  io.stderr.write(problems ? `\n${problems} problem${problems === 1 ? "" : "s"} found.\n` : "\nAll good.\n");
  return problems ? EXIT.failed : EXIT.ok;
}
