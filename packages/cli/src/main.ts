#!/usr/bin/env bun
import { parseArgs } from "./args.ts";
import { chatCommand } from "./commands/chat.ts";
import { checkpointsCommand, restoreCommand } from "./commands/checkpoints.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { acpCommand } from "./commands/acp.ts";
import { guardCommand } from "./commands/guard.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { pluginCommand } from "./commands/plugin.ts";
import { webCommand } from "./commands/web.ts";
import { updateCommand } from "./commands/update.ts";
import { modelsCommand } from "./commands/models.ts";
import { EXIT, runCommand } from "./commands/run.ts";
import { serveCommand } from "./commands/serve.ts";
import { ensureGuestModels } from "./guest-models.ts";
import { serveHttpCommand } from "./commands/serve-http.ts";
import { a2aCommand, serveA2aCommand } from "./commands/a2a.ts";
import { HELP, VERSION } from "./help.ts";
import { configPath, loadConfig } from "./config.ts";
import { processIO, type IO } from "./io.ts";
import { runSandboxHelper, useSandboxHelper } from "@navvied/engine";
import { selfArgv } from "./create.ts";
import { resolveTheme, setTheme } from "./theme.ts";

export async function main(argv: readonly string[], io: IO = processIO()): Promise<number> {
  // Not a command a person types: how a command is confined on Windows (the engine starts this program again for it).
  if (argv[0] === "sandbox-run") return runSandboxHelper(argv.slice(1));
  if (process.platform === "win32") useSandboxHelper(selfArgv());
  const parsed = parseArgs(argv);
  if (!parsed.ok) { io.stderr.write(`error: ${parsed.error}\n`); return EXIT.usage; }
  const { command, prompt, options } = parsed;
  const env: IO = options.color === undefined ? io : { ...io, color: options.color };
  const file = loadConfig(configPath(env.env, options.config), env.env);
  setTheme(resolveTheme(file.ok ? file.value : null, env.env));

  switch (command) {
    case "help": io.stdout.write(HELP); return EXIT.ok;
    case "version": io.stdout.write(`${VERSION}\n`); return EXIT.ok;
    case "acp": return acpCommand(options, env);
    case "guard": return guardCommand(options, env);
    case "schedule": return scheduleCommand(prompt, options, env);
    case "plugin": return pluginCommand(prompt, options, env);
    case "models": return modelsCommand(options, env);
    case "init": await ensureGuestModels(env, options); return chatCommand(prompt, { ...options, providers: true }, env);
    case "update": return updateCommand(prompt, env);
    case "doctor": return doctorCommand(options, env);
    case "checkpoints": return checkpointsCommand(options, env);
    case "restore": return restoreCommand(prompt, options, env);
    case "run": return runCommand(prompt, options, env);
    case "a2a": return a2aCommand(prompt, env);
    case "serve": if (options.a2a && !options.http) return serveA2aCommand(options, env);
      if (options.http) await ensureGuestModels(env, options); return options.http ? serveHttpCommand(options, env) : serveCommand(options, env);
    case "web": return webCommand(options, env);
    case "chat": await ensureGuestModels(env, options); return chatCommand(prompt, options, env);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
