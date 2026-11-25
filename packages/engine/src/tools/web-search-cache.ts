/**
 * The answers of the searches made lately, for 20 minutes: the same words asked twice are not sent twice, and the same words asked while the first is still on its way share
 * its answer (one request, not two). A failure is never kept.
 */
export class SearchCache {
  readonly #made = new Map<string, { at: number; text: Promise<string> }>();
  constructor(private readonly ttlMs = 20 * 60_000, private readonly most = 50, public now: () => number = Date.now) {}

  async get(key: string, make: () => Promise<string>, keep: (text: string) => boolean): Promise<string> {
    const had = this.#made.get(key);
    if (had && this.now() - had.at < this.ttlMs) return had.text;
    const text = make();
    this.#made.set(key, { at: this.now(), text });
    for (const old of [...this.#made.keys()]) { if (this.#made.size <= this.most) break; this.#made.delete(old); }
    const forget = (): void => { if (this.#made.get(key)?.text === text) this.#made.delete(key); };
    try { if (!keep(await text)) forget(); } catch (e) { forget(); throw e; }
    return text;
  }

  clear(): void { this.#made.clear(); }
}

/** The one cache of this program. */
export const searches = new SearchCache();
