import { connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** One tool call of the program, as its hook was given it. */
export interface AskedCall { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; cwd?: unknown }

/**
 * What the engine says of a call: `allow` (the program is told so out loud, which is what lets it run without asking itself),
 * `deny` with what the model is told, or `pass` (say nothing: the program's own mode, such as Plan, stays in charge).
 */
export type AskReply =
  | { decision: "allow"; input?: Record<string, unknown> }
  | { decision: "deny"; message: string }
  | { decision: "pass" };

export const ASK_ADDRESS = "NAVVIED_ASK";
export const ASK_TOKEN = "NAVVIED_ASK_TOKEN";

const MOST = 1_000_000;

/**
 * The place a program's hook asks the engine about a tool. The engine listens on this computer only, at an address and with a token
 * it gives the program through its environment, so only what the program started can ask. A hook sends one line and is answered with
 * one line; if the hook goes away before the answer, the question is dropped (`gone` aborts).
 */
export class AskServer {
  readonly #token = randomBytes(24).toString("hex");
  #server: { port: number; stop(closeActive?: boolean): void } | undefined;

  constructor(private readonly answer: (call: AskedCall, gone: AbortSignal) => Promise<AskReply>) {}

  /** The environment that lets a hook ask (the address is known at once). */
  listen(): Record<string, string> {
    this.#server ??= Bun.listen<{ text: string; gone: AbortController }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => { socket.data = { text: "", gone: new AbortController() }; },
        data: (socket, chunk) => {
          socket.data.text += chunk.toString("utf8");
          if (socket.data.text.length > MOST) { socket.end(); return; }
          const end = socket.data.text.indexOf("\n");
          if (end < 0) return;
          const line = socket.data.text.slice(0, end);
          socket.data.text = "";
          void this.#serve(line, socket.data.gone.signal).then((reply) => { try { socket.end(`${JSON.stringify(reply)}\n`); } catch { /* the hook went away */ } });
        },
        close: (socket) => socket.data?.gone.abort(),
        error: (socket) => socket.data?.gone.abort(),
      },
    });
    return { [ASK_ADDRESS]: `127.0.0.1:${this.#server!.port}`, [ASK_TOKEN]: this.#token };
  }

  async #serve(line: string, gone: AbortSignal): Promise<AskReply> {
    let request: { token?: unknown; call?: AskedCall };
    try { request = JSON.parse(line); } catch { return { decision: "deny", message: "navvied could not read the question." }; }
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    const mine = Buffer.from(this.#token);
    if (given.length !== mine.length || !timingSafeEqual(given, mine)) return { decision: "deny", message: "navvied did not accept the question." };
    try { return await this.answer(request.call ?? {}, gone); } catch { return { decision: "deny", message: "navvied could not decide, so it was not allowed." }; }
  }

  close(): void { this.#server?.stop(true); this.#server = undefined; }
}

/**
 * What a hook does with a tool call: asks the engine that started the program, and turns the answer into what a hook says (a
 * decision on standard output, or an exit code of 2 and a sentence on standard error that the model is told). Nothing that cannot be
 * answered is allowed: with no engine to ask, or no answer, the tool is stopped.
 */
export async function askEngine(env: Record<string, string | undefined>, stdin: string, wait = 3_600_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const stop = (why: string) => ({ code: 2, stdout: "", stderr: `${why} Do not try again; tell the user what you wanted to do.\n` });
  const address = env[ASK_ADDRESS], token = env[ASK_TOKEN];
  if (!address || !token) return stop("navvied cannot be asked about this, so it was not allowed.");
  let call: AskedCall;
  try { call = JSON.parse(stdin); } catch { return stop("navvied could not read this tool call, so it was not allowed."); }
  const [host, port] = [address.slice(0, address.lastIndexOf(":")), Number(address.slice(address.lastIndexOf(":") + 1))];
  const reply = await new Promise<AskReply | undefined>((resolve) => {
    const socket = connect({ host, port });
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, wait);
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, call })}\n`));
    socket.on("data", (d) => { text += d.toString("utf8"); });
    socket.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(text.trim()) as AskReply); } catch { resolve(undefined); } });
    socket.on("error", () => { clearTimeout(timer); resolve(undefined); });
  });
  if (!reply) return stop("navvied did not answer, so it was not allowed.");
  if (reply.decision === "deny") return { code: 2, stdout: "", stderr: `${reply.message}\n` };
  if (reply.decision === "pass") return { code: 0, stdout: "", stderr: "" };
  const out = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "The person, or navvied's rules, allowed this.", ...(reply.input ? { updatedInput: reply.input } : {}) } };
  return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
}
