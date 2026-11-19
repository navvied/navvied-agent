export function sortDescending(values: number[]): number[] {
  return [...values].sort((a, b) => b - a);
}
