/**
 * The text of a page, in the characters its author wrote it in. What the answer's header says counts first, then a byte-order mark, then what the page says about itself in its
 * first kilobytes (`<meta charset>` or the `content-type` meta), and last the way a page with no word on it is read: as UTF-8 when it is, else as the old Western encoding.
 */
/** A label the author wrote may be one the platform does not know (the type only lists the common ones, the platform knows more): then there is none. */
const decoder = (label: string): TextDecoder | undefined => { try { return new TextDecoder(label as "utf-8"); } catch { return undefined; } };

/** The encoding named in a `content-type` header or a meta tag, as a label the platform knows. */
export function charsetOf(text: string): string | undefined {
  const label = /charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(text)?.[1];
  return label && decoder(label) ? label : undefined;
}

export function decodeBody(bytes: Uint8Array, header = ""): string {
  const fromHeader = charsetOf(header);
  if (fromHeader) return decoder(fromHeader)!.decode(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decoder("utf-8")!.decode(bytes);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return decoder(bytes[0] === 0xff ? "utf-16le" : "utf-16be")!.decode(bytes);
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const meta = /<meta\b[^>]*>/gi;
  for (let m = meta.exec(head); m; m = meta.exec(head)) {
    const label = charsetOf(m[0]);
    if (label) return decoder(label)!.decode(bytes);
  }
  // `stream` keeps a character cut at the end of a page that was read only up to a limit from counting as a wrong byte.
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }); } catch { return decoder("windows-1252")!.decode(bytes); }
}
