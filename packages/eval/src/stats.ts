/** The 95% Wilson interval of a pass rate, in whole percent: it stays sensible for a handful of runs, where "3 of 4" is not "75%". */
export function wilson(passed: number, total: number): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 100 };
  const z = 1.96, p = passed / total, d = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return { lo: Math.max(0, Math.round((centre - half) * 100)), hi: Math.min(100, Math.round((centre + half) * 100)) };
}

export const rate = (passed: number, total: number): string => { const w = wilson(passed, total); return `${passed}/${total} (${Math.round((passed / (total || 1)) * 100)}%, ${w.lo} to ${w.hi}%)`; };
