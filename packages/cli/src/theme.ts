export type ThemeName = "light" | "dark" | "jarvis" | "raphael";

/** The same palette as navvied.com: the accent, the secondary text colour and the faint colour used for rules. */
export const THEMES: Record<ThemeName, { accent: string; dim: string; faint: string; hint: string }> = {
  light: { accent: "#6d5cf0", dim: "#5d5d5d", faint: "#a8a8a8", hint: "clean daylight" },
  dark: { accent: "#8b7cff", dim: "#afafaf", faint: "#5f5f5f", hint: "calm dark" },
  jarvis: { accent: "#40aef2", dim: "#8aa8c0", faint: "#3b5268", hint: "blue HUD" },
  raphael: { accent: "#e8ad3c", dim: "#c4b48f", faint: "#6b5f45", hint: "amber" },
};

export const ACCENTS: Record<string, string> = {
  orange: "#f97316", violet: "#8b7cff", indigo: "#6d5cf0", blue: "#3b82f6", cyan: "#22d3ee", teal: "#14b8a6",
  green: "#22c55e", amber: "#f59e0b", rose: "#f43f5e", pink: "#ec4899",
};

export interface Theme { name: ThemeName; accent: string; dim: string; faint: string; truecolor: boolean }

type Env = Record<string, string | undefined>;

const HEX = /^#[0-9a-f]{6}$/i;
export const isThemeName = (v: unknown): v is ThemeName => typeof v === "string" && v in THEMES;
export const parseAccent = (v: string): string | undefined => (HEX.test(v) ? v.toLowerCase() : ACCENTS[v.toLowerCase()]);

/** The theme from the configuration, else the terminal's own light/dark setting, else dark. */
export function resolveTheme(file: { theme?: string; accent?: string } | null | undefined, env: Env): Theme {
  const light = /;(15|7)$/.test(env.COLORFGBG ?? "");
  const name = isThemeName(file?.theme) ? file.theme : light ? "light" : "dark";
  const accent = (file?.accent && parseAccent(file.accent)) || THEMES[name].accent;
  return { name, accent, dim: THEMES[name].dim, faint: THEMES[name].faint, truecolor: /truecolor|24bit/i.test(env.COLORTERM ?? "") };
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

export const mix = (hex: string, other: string, amount: number): string => {
  const a = rgb(hex), b = rgb(other);
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * amount).toString(16).padStart(2, "0")).join("")}`;
};

const to256 = ([r, g, b]: [number, number, number]): number => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);

/** The escape sequence that switches the text colour to `hex`. */
export const fg = (hex: string, truecolor: boolean): string => {
  const c = rgb(hex);
  return truecolor ? `\u001b[38;2;${c[0]};${c[1]};${c[2]}m` : `\u001b[38;5;${to256(c)}m`;
};

let active: Theme = resolveTheme(null, {});
export const setTheme = (t: Theme): void => { active = t; };
export const currentTheme = (): Theme => active;

/** The escape sequence that switches the background colour to `hex`. */
export const bg = (hex: string, truecolor: boolean): string => {
  const c = rgb(hex);
  return truecolor ? `\u001b[48;2;${c[0]};${c[1]};${c[2]}m` : `\u001b[48;5;${to256(c)}m`;
};

export type Rgb = readonly [number, number, number];

const SURFACES = {
  dark: { code: [36, 36, 46], addBg: [30, 62, 44], addFg: [150, 235, 180], delBg: [70, 36, 40], delFg: [245, 150, 150], ok: [110, 220, 150], bad: [240, 120, 120], warn: [240, 200, 100] },
  light: { code: [238, 238, 246], addBg: [214, 240, 222], addFg: [20, 100, 50], delBg: [250, 222, 222], delFg: [150, 40, 40], ok: [30, 140, 70], bad: [190, 50, 50], warn: [170, 110, 0] },
} as const satisfies Record<string, Record<string, Rgb>>;

/** The colours of the blocks in the conversation: the person's message, code, added and removed lines, and the status marks. */
export const surfaces = (t: Theme): { [K in keyof (typeof SURFACES)["dark"]]: Rgb } => (t.name === "light" ? SURFACES.light : SURFACES.dark);

const grey = (c: Rgb): number => to256([c[0], c[1], c[2]]);
export const fgRgb = (c: Rgb, truecolor: boolean): string => (truecolor ? `\u001b[38;2;${c[0]};${c[1]};${c[2]}m` : `\u001b[38;5;${grey(c)}m`);
export const bgRgb = (c: Rgb, truecolor: boolean): string => (truecolor ? `\u001b[48;2;${c[0]};${c[1]};${c[2]}m` : `\u001b[48;5;${grey(c)}m`);
