import type { Socket, SocketHandler } from "bun";
import { vet, web } from "../web-guard.ts";

/**
 * Every connection the browser makes goes through this proxy on the loopback address, so what the web guard decides holds for all of them:
 * pages, scripts, WebSockets and anything else that opens a socket, which the browser's own request interception never sees. A name is
 * looked up here, every address it has must be public, and the connection is made to the address that was checked (a name that changes
 * its answer between the check and the visit reaches nothing the check did not allow). A secure page is tunnelled untouched: only its
 * host is known, and that is what is checked.
 */

interface Side {
  peer?: Socket<Side>;
  /** What waits to be written to this socket. */
  queue: Uint8Array[];
  /** `head`: the first request is still being read; `connecting`: it is being vetted, and what follows waits in `held`; `open`: bytes go straight across. */
  phase: "head" | "connecting" | "open";
  head: Buffer;
  held: Buffer[];
  done?: boolean;
}

const side = (peer?: Socket<Side>): Side => ({ queue: [], phase: "open", head: Buffer.alloc(0), held: [], ...(peer ? { peer } : {}) });

const flush = (s: Socket<Side>): void => {
  const q = s.data.queue;
  while (q.length) {
    const n = s.write(q[0]!);
    if (n < 0) { q.length = 0; return; }
    if (n < q[0]!.length) { q[0] = q[0]!.subarray(n); return; }
    q.shift();
  }
};
const send = (s: Socket<Side>, chunk: Uint8Array): void => { s.data.queue.push(chunk); flush(s); };
const hangUp = (s: Socket<Side>): void => { if (s.data.done) return; s.data.done = true; try { s.end(); } catch { /* gone */ } if (s.data.peer) hangUp(s.data.peer); };

const END = Buffer.from("\r\n\r\n");
const deny = (s: Socket<Side>, why: string): void => { send(s, Buffer.from(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(why)}\r\n\r\n${why}`)); hangUp(s); };

export interface GuardProxy { readonly port: number; close(): void }

/**
 * `allowPrivate` is asked at each connection (the host's choice can change between calls); `refused` hears why a connection to `host` was not made,
 * for the sentence that tells the person a page could not be opened; the browser's own background traffic comes through here too, so
 * the listener must match the host against what a page asked for.
 */
export function startGuardProxy(allowPrivate: () => boolean, refused: (why: string, host: string) => void): GuardProxy {
  const upstreamHandlers: SocketHandler<Side> = {
    data(up, chunk) { if (up.data.peer) send(up.data.peer, chunk); },
    drain: flush,
    close: hangUp,
    error: hangUp,
  };

  /** Vets the host and connects to an address that was checked; nothing is said to the browser here. */
  async function dial(client: Socket<Side>, host: string, port: number): Promise<Socket<Side> | undefined> {
    const v = await vet(new URL(`https://${host.includes(":") ? `[${host}]` : host}`), allowPrivate());
    if ("refused" in v) { refused(v.refused, host); deny(client, v.refused); return undefined; }
    for (const address of v.pin.length ? v.pin.slice(0, 4) : [host]) {
      try { return await web.dial(address, port, upstreamHandlers, side(client)); } catch { /* the next address */ }
    }
    deny(client, `${host} could not be reached.`);
    return undefined;
  }

  async function begin(s: Socket<Side>, all: Buffer, end: number): Promise<void> {
    const lines = all.subarray(0, end).toString("latin1").split("\r\n");
    const rest = all.subarray(end + END.length);
    const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0]!);
    if (!m) { deny(s, "the request could not be read."); return; }
    let first: Buffer, up: Socket<Side> | undefined;
    if (m[1] === "CONNECT") {
      const hp = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(m[2]!);
      if (!hp) { deny(s, "the address could not be read."); return; }
      up = await dial(s, hp[1] ?? hp[2]!, Number(hp[3]));
      first = Buffer.concat([rest]);
      if (up) send(s, Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
    } else {
      const url = new URL(m[2]!);
      if (url.protocol !== "http:") { deny(s, "only http addresses are forwarded; secure ones are tunnelled."); return; }
      up = await dial(s, url.hostname.replace(/^\[|\]$/g, ""), Number(url.port) || 80);
      // One request per connection: the address was checked for this request, so the connection is not reused for another.
      const kept = lines.slice(1).filter((l) => !/^(connection|proxy-connection|keep-alive|proxy-authorization):/i.test(l));
      first = Buffer.concat([Buffer.from(`${m[1]} ${url.pathname}${url.search} HTTP/1.1\r\n${kept.join("\r\n")}\r\nconnection: close\r\n\r\n`, "latin1"), rest]);
    }
    if (!up) return;
    s.data.peer = up;
    s.data.phase = "open";
    send(up, Buffer.concat([first, ...s.data.held]));
    s.data.held = [];
  }

  const server = Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) { s.data = { ...side(), phase: "head" }; },
      drain: flush,
      close: hangUp,
      error: hangUp,
      data(s, chunk) {
        const d = s.data;
        if (d.phase === "open") { if (d.peer) send(d.peer, chunk); return; }
        if (d.phase === "connecting") { d.held.push(Buffer.from(chunk)); return; }
        const all = Buffer.concat([d.head, chunk]);
        const end = all.indexOf(END);
        if (end < 0) { if (all.length > 32_768) deny(s, "the request is too large."); else d.head = all; return; }
        d.phase = "connecting";
        begin(s, all, end).catch(() => deny(s, "the request could not be made."));
      },
    },
  });
  return { port: server.port, close: () => server.stop(true) };
}
