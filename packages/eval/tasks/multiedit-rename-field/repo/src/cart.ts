export interface Line { sku: string; qty: number; unit: number }

export function total(lines: Line[]): number {
  return lines.reduce((s, l) => s + l.qty * l.unit, 0);
}

export function count(lines: Line[]): number {
  return lines.reduce((s, l) => s + l.qty, 0);
}

export function add(lines: Line[], sku: string, qty: number, unit: number): Line[] { return [...lines, { sku, qty, unit }]; }
