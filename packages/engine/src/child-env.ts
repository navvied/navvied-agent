import { secretsNow } from "./redact.ts";

/** Names that say a variable holds a secret. */
const NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL)/i;

/** What a command may not inherit: the names listed, and the keys navvied itself was configured with. `keep` is what the person said a command may have anyway. */
export interface EnvPolicy { drop?: readonly string[]; keep?: readonly string[] }

/** The names in `env` that look like secrets: what the program passes as `drop`. */
export const secretNames = (env: NodeJS.ProcessEnv = process.env): string[] => Object.keys(env).filter((k) => NAME.test(k));

/**
 * The environment a command or a background job starts with: this program's own, without the keys it uses to reach the model (a command
 * the model writes, or one a web page talked it into, would otherwise print them or send them away). PATH, HOME and the rest stay.
 */
export function childEnv(base: NodeJS.ProcessEnv, policy: EnvPolicy = {}, registered: readonly string[] = secretsNow({})): NodeJS.ProcessEnv {
  const keep = new Set(policy.keep), drop = new Set(policy.drop), keys = new Set(registered);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!keep.has(name) && (drop.has(name) || keys.has(value))) continue;
    out[name] = value;
  }
  return out;
}
