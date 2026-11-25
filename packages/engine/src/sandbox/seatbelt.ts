import type { Plan, Setting } from "./policy.ts";

const text = (path: string): string => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The profile for `sandbox-exec` on macOS. Later rules win, so it says: everything is allowed, nothing may be written, the folders of the
 * plan may be, and what the plan hides can be neither read nor written (also where a writable folder holds it). macOS spells a few
 * folders through /private; both spellings are listed, since the profile compares the real one.
 */
export function seatbeltProfile(plan: Plan, setting: Pick<Setting, "network">): string {
  const spellings = (p: string): string[] => (/^\/(tmp|var|etc)(\/|$)/.test(p) ? [p, `/private${p}`] : p.startsWith("/private/") ? [p, p.slice(8)] : [p]);
  const subpaths = (list: readonly string[]): string => list.flatMap(spellings).map((p) => `(subpath ${text(p)})`).join(" ");
  const files = plan.hiddenFiles.flatMap(spellings).map((p) => `(literal ${text(p)})`).join(" ");
  const hidden = [subpaths(plan.hiddenDirs), files].filter(Boolean).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${subpaths(plan.writable)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/(tty|ttys[0-9]+|pty[a-z0-9]+)$"))`,
    ...(hidden ? [`(deny file-read* ${hidden})`, `(deny file-write* ${hidden})`] : []),
    ...(setting.network ? [] : ["(deny network*)", '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))']),
  ].join("\n");
}
