/**
 * `navvied serve --stdio`: run the engine as a protocol server on standard input/output, so another program (a web
 * server, an editor) can drive it. Standard output carries protocol lines only; diagnostics go to standard error.
 * It is the same hub as the one a page on this computer talks to, so an agent and a chat can both be open in one session:
 * a command says which it is for, and what each says carries its kind. What is said is also written down in the state folder
 * (one record per kind), so a host that keeps that folder (a hosted session) can list the conversations afterwards.
 */
import { EventEncoder, LineSplitter } from "@navvied/protocol";
import type { Options } from "../args.ts";
import type { IO } from "../io.ts";
import { createHub } from "./hub.ts";
import { EXIT } from "./run.ts";

export async function serveCommand(options: Options, io: IO): Promise<number> {
  const hub = createHub(options, io, { watch: false });
  if (!hub.connected()) {
    const message = hub.error();
    io.stdout.write(new EventEncoder().encode({ ev: "error", msg: message }));
    io.stderr.write(`error: ${message}\n`);
    await hub.stop();
    return EXIT.usage;
  }
  const host = hub.attach({ send: (line) => io.stdout.write(`${line}\n`) }, 0);

  const splitter = new LineSplitter();
  const handleLine = (line: string): void => { host.command(line); };

  const off = io.onInterrupt(() => hub.cancel());
  for await (const chunk of io.stdin) {
    try { for (const line of splitter.push(chunk)) handleLine(line); }
    catch (e) { io.stdout.write(`${JSON.stringify({ ev: "error", msg: e instanceof Error ? e.message : String(e) })}\n`); }
  }
  for (const line of splitter.flush()) handleLine(line);

  await hub.stop(); // the host closed its end: let the running turns finish
  off();
  return EXIT.ok;
}
