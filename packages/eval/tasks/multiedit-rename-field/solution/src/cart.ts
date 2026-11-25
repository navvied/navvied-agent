export interface Line { sku: string; quantity: number; unit: number }

export function total(lines: Line[]): number {
  return lines.reduce((s, l) => s + l.quantity * l.unit, 0);
}

export function count(lines: Line[]): number {
  return lines.reduce((s, l) => s + l.quantity, 0);
}

export function add(lines: Line[], sku: string, quantity: number, unit: number): Line[] { return [...lines, { sku, quantity, unit }]; }
