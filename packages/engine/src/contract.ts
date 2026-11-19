import type { Command } from "@navvied/protocol";

/**
 * What every engine offers a front-end: feed it commands, it emits protocol events (through the sink given at
 * construction). Implemented by the native {@link Engine} and by adapters that drive an external agent process.
 */
export interface AgentEngine {
  /** The session id, once known (an external agent may only report it after the first message). */
  readonly sessionId: string;
  handle(cmd: Command): void;
  idle(): Promise<void>;
  close(): void;
}
