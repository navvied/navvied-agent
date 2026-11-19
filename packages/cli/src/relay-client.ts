import { Opener, Sealer, fromBase64Url, pairingFrom } from "@navvied/protocol";
import type { SocketLike } from "./relay-host.ts";

export interface Talk {
  /** The relay's WebSocket address. */
  url: string;
  /** The pairing secret of the computer to talk to (base64url), as the account keeps it. */
  secret: string;
  /** What to send once the computer has let this program in, in order. */
  send: object[];
  /** Looks at what the computer says; answers when it has the answer to what was sent. */
  until: (event: Record<string, unknown>) => { ok: boolean; msg?: string } | undefined;
  timeoutMs?: number;
  open?: (url: string) => SocketLike;
}

/**
 * Talks to another computer of the same account through the relay, the way a page does: it joins that computer's channel, says hello,
 * sends its commands and waits for the answer. Everything after the hello is sealed; the relay only forwards frames and keeps nothing.
 * Resolves to why it did not work when the computer cannot be reached or does not answer.
 */
export async function talkToComputer(t: Talk): Promise<{ ok: boolean; msg?: string }> {
  let pairing;
  try { pairing = await pairingFrom(fromBase64Url(t.secret) as Uint8Array<ArrayBuffer>); } catch { return { ok: false, msg: "unreachable" }; }
  const sealer = new Sealer(pairing, "client"), opener = new Opener(pairing, "engine");
  return new Promise((resolve) => {
    const socket = (t.open ?? ((u) => new WebSocket(u) as unknown as SocketLike))(t.url);
    let over = false;
    let opening: Promise<void> = Promise.resolve();
    let sent = false;
    const finish = (result: { ok: boolean; msg?: string }): void => { if (over) return; over = true; clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, msg: "no-answer" }), t.timeoutMs ?? 20_000);
    // Everything is sent in order, one sealed message after another.
    let sending: Promise<void> = Promise.resolve();
    const queue = (value: object): void => { sending = sending.then(async () => { const d = await sealer.seal(JSON.stringify(value)); try { socket.send(JSON.stringify({ t: "d", d })); } catch { finish({ ok: false, msg: "unreachable" }); } }); };
    const begin = (): void => { queue({ navvied: "hello", since: 0 }); };
    socket.onopen = () => { socket.send(JSON.stringify({ t: "hello", role: "client", c: pairing.channel, a: pairing.proof })); };
    socket.onmessage = (e) => {
      let msg: { t?: string; engine?: boolean; up?: boolean; d?: string; code?: string };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.t === "ready") { if (msg.engine === true) begin(); else finish({ ok: false, msg: "unreachable" }); return; }
      if (msg.t === "engine") { if (msg.up === false) finish({ ok: false, msg: "unreachable" }); else begin(); return; }
      if (msg.t === "error") { finish({ ok: false, msg: "unreachable" }); return; }
      if (msg.t === "d" && typeof msg.d === "string") {
        const sealed = msg.d;
        opening = opening.then(async () => {
          let event: Record<string, unknown>;
          try { event = JSON.parse(await opener.open(sealed)) as Record<string, unknown>; } catch { return; }
          if (event.ev === "error" && !sent) { finish({ ok: false, msg: "not-allowed" }); return; }
          if (event.ev === "alive" && !sent) { sent = true; for (const c of t.send) queue(c); return; }
          const answer = t.until(event);
          if (answer) finish(answer);
        });
      }
    };
    socket.onclose = () => finish({ ok: false, msg: "unreachable" });
    socket.onerror = () => undefined;
  });
}
