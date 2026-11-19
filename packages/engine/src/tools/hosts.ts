/**
 * Which addresses an agent may not reach unless the host opts in: this computer, the local network, and everything that only
 * means one of those. The address is first written the way a URL writes it, so `2130706433`, `0x7f.1` and `0:0:0:0:0:ffff:7f00:1`
 * are judged as what they are. A name is judged by its ending only: what it would resolve to is not looked up here.
 */

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

/** An IPv4 address (four numbers) in a range that is not the public internet. */
export function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a! >= 224
    || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

/** The eight 16-bit groups of an IPv6 address as a URL writes it (compressed, lower case, no dotted tail), or nothing. */
function groups(address: string): number[] | undefined {
  const [head = "", tail, more] = address.split("::");
  if (more !== undefined) return undefined;
  const side = (text: string): number[] | undefined => {
    if (text === "") return [];
    const out = text.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return out.some(Number.isNaN) ? undefined : out;
  };
  const front = side(head), back = tail === undefined ? [] : side(tail);
  if (!front || !back) return undefined;
  const missing = 8 - front.length - back.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  return [...front, ...new Array<number>(tail === undefined ? 0 : missing).fill(0), ...back];
}

const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function privateV6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.slice(0, 7).every((x) => x === 0)) return g7 <= 1;
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return privateV4(embedded(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && privateV4(embedded(g6, g7)));
  if (g0 === 0x2002) return privateV4(embedded(g1, g2));
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true;
  return g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0;
}

export function isPrivateHost(hostname: string): boolean {
  const written = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (LOCAL_NAMES.test(written)) return true;
  const numeric = written.includes(":") || /^[0-9a-fx.]+$/.test(written);
  if (!numeric) return false;
  let host: string;
  try { host = new URL(`http://${written.includes(":") ? `[${written}]` : written}`).hostname.replace(/^\[|\]$/g, ""); } catch { return true; }
  if (host.includes(":")) { const g = groups(host); return g ? privateV6(g) : true; }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 ? privateV4(v4.slice(1).map(Number)) : false;
}
