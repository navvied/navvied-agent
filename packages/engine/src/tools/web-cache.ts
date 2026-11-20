/**
 * The text of the pages read lately, kept for 15 minutes per address, so reading a long page on (`offset`) costs no second visit and a
 * page asked for twice is not fetched twice.
 */
export interface Page { url: string; title: string; /** The text and, after it, the list of links. */ text: string; at: number }

export class PageCache {
  readonly #pages = new Map<string, Page>();
  constructor(private readonly ttlMs = 15 * 60_000, private readonly most = 40, public now: () => number = Date.now) {}

  /** The address without what does not change the page. */
  static key(url: string): string { try { const u = new URL(url); u.hash = ""; return u.href; } catch { return url; } }

  get(url: string): Page | undefined {
    const key = PageCache.key(url), page = this.#pages.get(key);
    if (!page) return undefined;
    if (this.now() - page.at > this.ttlMs) { this.#pages.delete(key); return undefined; }
    return page;
  }

  set(url: string, page: Omit<Page, "at" | "url">): Page {
    const key = PageCache.key(url);
    this.#pages.delete(key);
    const saved = { ...page, url: key, at: this.now() };
    this.#pages.set(key, saved);
    for (const old of [...this.#pages.keys()]) { if (this.#pages.size <= this.most) break; this.#pages.delete(old); }
    return saved;
  }

  clear(): void { this.#pages.clear(); }
}

/** The one cache of this program. */
export const pages = new PageCache();
