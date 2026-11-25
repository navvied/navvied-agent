/**
 * The places that hold a person's keys and passwords, in one list. Three guards read it: what is asked about after the web was read
 * (taint.ts), what a write needs the person's say-so for (risk.ts), and what a command running in the sandbox cannot see (sandbox/).
 */

/** Folders, by name, wherever they are (in a home folder, in a project). */
export const SECRET_DIRS: readonly string[] = [".ssh", ".gnupg", ".aws", ".kube", ".azure", ".docker"];
/** Files, by name. `_netrc` is the Windows spelling of `.netrc`. */
export const SECRET_FILES: readonly string[] = [".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", "_netrc"];
/** Where browsers keep logins and cookies, relative to a home folder. */
export const BROWSER_PROFILES: readonly string[] = [
  ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/vivaldi", ".mozilla",
  "snap/chromium/common/chromium", "snap/firefox/common/.mozilla",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/Microsoft Edge", "Library/Application Support/BraveSoftware", "Library/Safari", "Library/Cookies",
  "AppData/Local/Google/Chrome/User Data", "AppData/Local/Microsoft/Edge/User Data", "AppData/Roaming/Mozilla/Firefox",
];

const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (names: readonly string[]): string => names.map(escape).join("|");

/** `.env` holds keys; an example, sample, template or dist copy of one does not. */
const ENV_FILE = String.raw`\.env(?:\.(?!(?:example|sample|template|dist)$)[\w.-]+)?$`;

/** A path (forward slashes) that is one of the places above, or a file that is made to hold a key. */
const SECRET = new RegExp(
  String.raw`(?:^|[/=@:])(?:(?:${alternatives(SECRET_DIRS)})(?:\/|$)|(?:${alternatives(SECRET_FILES)})$|${ENV_FILE}|(?:${alternatives(BROWSER_PROFILES)})(?:\/|$))`
  + String.raw`|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$|^\/etc\/(?:shadow|gshadow|sudoers)$|\.(?:pem|key|p12|pfx)$`,
  "i",
);

export const isSecretPath = (path: string): boolean => SECRET.test(path.replace(/\\/g, "/"));

/** The folder names above as the inside of a regular expression, for a guard that reads a path its own way. */
export const secretDirNames = (): string => alternatives(SECRET_DIRS);
