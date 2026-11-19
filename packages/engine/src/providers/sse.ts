/** Minimal server-sent-events reader: yields the `data:` payload of each event, stops at `[DONE]`. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }
  const tail = buf.trim();
  if (tail.startsWith("data:")) { const data = tail.slice(5).trim(); if (data && data !== "[DONE]") yield data; }
}
