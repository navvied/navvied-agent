/**
 * What a connected program may ask of this side, not the other way round: a model completion (`sampling/createMessage`) and a question for the
 * person (`elicitation/create`). The client only carries the request; what is allowed, asked and run is decided here, per server.
 */
import type { McpServerConfig } from "./mcp.ts";
import type { Elicitor } from "./mcp-elicit.ts";
import type { Sampler } from "./mcp-sampling.ts";

/** A request that is refused, with the JSON-RPC code and the words the server is sent. */
export class McpRequestError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
/** The code the specification gives a person's refusal of a sampling request. */
export const REFUSED = -1;
export const INVALID = -32602;

export type RequestHandler = (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/** The requests one server may make: what is missing is not advertised in the handshake and is answered "not found". */
export interface McpHandlers { sampling?: RequestHandler; elicitation?: RequestHandler }

/** Gives each connected server its handlers, by what its configuration allows. */
export interface McpHost { handlers(server: string, config: McpServerConfig): McpHandlers }

export class McpAnswers implements McpHost {
  constructor(private readonly sampler: Sampler, private readonly elicitor: Elicitor) {}

  handlers(server: string, config: McpServerConfig): McpHandlers {
    return {
      ...(config.sampling === "off" ? {} : { sampling: (params, signal) => this.sampler.sample(server, config, params, signal) }),
      ...(config.elicitation === "off" ? {} : { elicitation: (params, signal) => this.elicitor.elicit(server, params, signal) }),
    };
  }

  /** A new turn starts: what a server may ask in one turn is counted again. */
  newTurn(): void { this.sampler.newTurn(); this.elicitor.newTurn(); }
}
