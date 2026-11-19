import { KeyParser, type Key } from "./keys.ts";

/**
 * Runs a menu in the normal terminal flow, where no whole-screen interface is open (`navvied init` from a shell): the
 * lines are printed, redrawn in place as keys arrive, and left on screen when it ends.
 */
export function runInline<T>(
  input: NodeJS.ReadStream,
  output: { write(text: string): unknown; columns?: number },
  render: (cols: number) => string[],
  apply: (key: Key) => T | undefined,
): Promise<T> {
  return new Promise((resolve) => {
    const parser = new KeyParser();
    let drawn = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draw = (): void => {
      const lines = render(output.columns ?? 80);
      output.write(`${drawn ? `\u001b[${drawn}A\u001b[0J` : ""}${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    const finish = (value: T): void => {
      clearTimeout(timer);
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\u001b[?25h");
      resolve(value);
    };
    const feed = (keys: Key[]): void => {
      for (const key of keys) {
        const outcome = apply(key);
        if (outcome !== undefined) { draw(); finish(outcome); return; }
      }
      draw();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk);
      clearTimeout(timer);
      feed(parser.push(text));
      if (text.endsWith("\u001b")) timer = setTimeout(() => { feed(parser.flush()); }, 30);
    };
    output.write("\u001b[?25l");
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    draw();
  });
}
