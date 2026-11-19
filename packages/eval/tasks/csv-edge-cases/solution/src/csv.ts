export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') { quoted = true; any = true; }
    else if (ch === ",") { row.push(cell); cell = ""; any = true; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; any = false;
    } else { cell += ch; any = true; }
  }
  if (any || cell) { row.push(cell); rows.push(row); }
  return rows;
}
