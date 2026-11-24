/** Why a request to a site did not get an answer, as far as the failure itself says. */
export type Unreached = "tls" | "timeout" | "network";

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i;
const TLS_WORDS = /certificate|self[- ]signed|\bssl\b|\btls\b|handshake|issuer/i;

export function whyUnreached(e: unknown): Unreached {
  const code = String((e as { code?: unknown } | undefined)?.code ?? "");
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (TLS_CODES.test(code) || TLS_WORDS.test(text)) return "tls";
  return /timed? ?out|abort/i.test(text) ? "timeout" : "network";
}

/**
 * What a person or a model is told when a site could not be reached. A certificate that is not the site's own is, on most networks, the network blocking the site
 * with a page of its own; it is said so, and never accepted (a bad certificate is never a way through).
 */
export function unreachedSentence(why: Unreached, site: string): string {
  if (why === "tls") return `${site} could not be reached safely from this network: its certificate is not the site's own, which usually means the network blocks it.`;
  return why === "timeout" ? `${site} did not answer in time.` : `${site} could not be reached from this network.`;
}
