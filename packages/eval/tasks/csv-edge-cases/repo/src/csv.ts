export function parseCsv(text: string): string[][] {
  return text.split("\n").map((line) => line.split(","));
}
