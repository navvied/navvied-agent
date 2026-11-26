import type { Command, EngineEvent } from "@navvied/protocol";
import type { Options } from "../args.ts";
import { createEngine } from "../create.ts";
import type { IO } from "../io.ts";
import { Renderer } from "../render.ts";
import { EXIT } from "./run.ts";

async function withEngine(options: Options, io: IO, act: (send: (command: Command) => Promise<void>) => Promise<void>): Promise<number> {
  if (!options.session) { io.stderr.write("error: --session <id> is required (the id is printed by /session, and by --json runs)\n"); return EXIT.usage; }
  const renderer = new Renderer(io, { thinking: false });
  let failed = false;
  const emit = (e: EngineEvent): void => { renderer.handle(e); if (e.ev === "error") failed = true; };
  const created = createEngine(options, io, emit);
  if (!created.ok) { io.stderr.write(`error: ${created.error}\n`); return EXIT.usage; }
  const { engine } = created.value;
  await act(async (command) => { engine.handle(command); await engine.idle(); });
  created.value.dispose();
  return failed ? EXIT.failed : EXIT.ok;
}

export const checkpointsCommand = (options: Options, io: IO): Promise<number> =>
  withEngine(options, io, async (send) => { await send({ cmd: "checkpoints" }); });

export const restoreCommand = (id: string | undefined, options: Options, io: IO): Promise<number> => {
  if (!id) { io.stderr.write("error: give the checkpoint id: navvied restore <id> --session <session>\n"); return Promise.resolve(EXIT.usage); }
  return withEngine(options, io, async (send) => {
    await send({ cmd: "restore", id, preview: true });
    if (options.yes) await send({ cmd: "restore", id });
    else io.stderr.write("preview only. Run again with --yes to restore.\n");
  });
};
