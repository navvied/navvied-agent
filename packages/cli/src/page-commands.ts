import type { MediaShelf, MemoryPaths } from "@navvied/engine";
import type { Command, EngineEvent } from "@navvied/protocol";
import { a2aList, addPeer, addToken, removePeer, revokeToken } from "./a2a-admin.ts";
import { PeerTokens } from "./a2a-tokens.ts";
import { a2aTokensPath, type Env } from "./config.ts";
import { changeNote, extractSetting, memoryNotes } from "./page-memory.ts";
import { pluginInstall } from "./plugin-install.ts";
import { pluginPlaces } from "./plugins.ts";
import { ONLY_ON_A_COMPUTER } from "./providers.ts";

/** What the hub knows that these commands need. */
export interface PageDeps {
  env: Env;
  /** The configuration file. */
  config: string;
  memory: () => MemoryPaths;
  shelf: MediaShelf;
  /** A conversation that runs in the cloud has no say over this computer's agents or plugins. */
  inCloud: () => boolean;
  /** The plugins of the person, as the page lists them (said again after an installation). */
  plugins: () => EngineEvent;
  today: () => string;
  fetch?: typeof fetch;
}

/** What an answer is made of: `say` goes to every window and is kept for those that arrive later; `reply` goes to the one who asked and is kept nowhere. */
export interface Answered { say: EngineEvent[]; reply: EngineEvent[] }

const error = (msg: string): Answered => ({ say: [], reply: [{ ev: "error", msg }] });
const said = (...say: EngineEvent[]): Answered => ({ say, reply: [] });

/**
 * The commands a page sends that need no conversation: what the engine made (`media.read`), the agents it may ask and the ones that may ask it (`a2a.*`), the notes the agent kept
 * and how it learns them (`memory.*`), and installing a plugin. Nothing here takes a path from the page except an installation's source, and that is only read, never run.
 */
export function pageCommand(cmd: Command, d: PageDeps): Answered | Promise<Answered> | undefined {
  const places = { env: d.env, config: d.config };
  switch (cmd.cmd) {
    case "media.read": {
      const got = d.shelf.read(cmd.id, cmd.offset, cmd.length);
      if ("error" in got) return error(got.error);
      return { say: [], reply: [{ ev: "media", id: cmd.id, mime: got.ref.mime, bytes: got.ref.bytes, offset: got.offset, data: got.data.toString("base64"), done: got.done }] };
    }
    case "a2a.list": return d.inCloud() ? error(ONLY_ON_A_COMPUTER) : said(a2aList(places));
    case "a2a.peer.add": case "a2a.peer.remove": case "a2a.token.add": case "a2a.token.revoke": {
      if (d.inCloud()) return error(ONLY_ON_A_COMPUTER);
      const tokens = new PeerTokens(a2aTokensPath(d.env));
      const done = cmd.cmd === "a2a.peer.add" ? addPeer(places, cmd) : cmd.cmd === "a2a.peer.remove" ? removePeer(places, cmd.name) : cmd.cmd === "a2a.token.revoke" ? revokeToken(tokens, cmd.name) : addToken(tokens, cmd.name);
      if (!done.ok) return error(done.error);
      // The token is in this answer only: the list every window gets never has it.
      return { say: [a2aList(places)], reply: cmd.cmd === "a2a.token.add" ? [{ ev: "a2a.token", name: cmd.name, token: (done.value as { token: string }).token }] : [] };
    }
    case "memory.list": return said(memoryNotes(d.memory(), cmd.scope));
    case "memory.edit": return { say: changeNote(d.memory(), { id: cmd.id, scope: cmd.scope, text: cmd.text }, d.today()), reply: [] };
    case "memory.forget": return { say: changeNote(d.memory(), { id: cmd.id, scope: cmd.scope }, d.today()), reply: [] };
    case "memory.extract": {
      const got = extractSetting(d.config, d.env, cmd.mode);
      return got.ok ? said(got.value) : error(got.error);
    }
    case "plugin.install": {
      if (d.inCloud()) return error(ONLY_ON_A_COMPUTER);
      return pluginInstall(cmd, pluginPlaces(d.config), d.fetch).then((a): Answered => ({ say: a.state === "done" ? [d.plugins()] : [], reply: [a] }));
    }
    default: return undefined;
  }
}
