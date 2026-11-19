export function parseAge(input: string): number {
  if (!/^-?\d+$/.test(input)) throw new TypeError(`not a whole number: ${JSON.stringify(input)}`);
  const n = Number(input);
  if (n < 0 || n > 150) throw new RangeError(`age out of range: ${n}`);
  return n;
}
