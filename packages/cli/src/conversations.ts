import { FileSessionStore, historyOf, type Recall } from "@navvied/engine";
import { chatJournalDir, chatSearchIndexPath, chatSessionsDir, configPath, journalDir, loadConfig, searchIndexPath, sessionsDir } from "./config.ts";
import { Journal, titleOf } from "./journal.ts";
import { meaningFor, vectorsFor, withMeaning, type Meaning } from "./meaning.ts";
import { SearchIndex } from "./search-index.ts";

/**
 * Where the conversations of one kind are kept and found: their saved messages, the record of what was said, the search index and
 * the agent's own way through them (the Recall tool). Every front-end (the hub, `run`, an editor) makes its engine through
 * `createEngine`, which holds one of these, so a conversation is kept and found the same way wherever it was had.
 */
export class Conversations {
  readonly storeDir: string;
  #index: SearchIndex | undefined;
  #closed = false;
  readonly #journalDir: string;
  readonly #indexPath: string;
  readonly #config: string;

  constructor(readonly kind: "agent" | "chat", private readonly env: Record<string, string | undefined>, private readonly project: () => string | undefined = () => undefined, config?: string) {
    this.#config = configPath(env, config);
    const chat = kind === "chat";
    this.storeDir = chat ? chatSessionsDir(env) : sessionsDir(env);
    this.#journalDir = chat ? chatJournalDir(env) : journalDir(env);
    this.#indexPath = chat ? chatSearchIndexPath(env) : searchIndexPath(env);
  }

  get index(): SearchIndex | undefined {
    if (this.#closed) return undefined;
    try { return (this.#index ??= new SearchIndex(this.#indexPath)); } catch { return undefined; }
  }

  /** Search by meaning, when the person set up a server for it in the configuration; otherwise nothing, and nothing is ever sent. */
  get meaning(): Meaning | undefined {
    const f = loadConfig(this.#config, this.env);
    return meaningFor(f.ok ? f.value?.memory?.embeddings : undefined, this.env, vectorsFor(this.#indexPath));
  }

  /** A record of one conversation's events that keeps the index up to date as it is saved. */
  journal(): Journal {
    return new Journal(this.#journalDir, (id, items) => {
      try { this.index?.put(id, titleOf(items), Date.now(), items); void this.meaning?.index(id, items).catch(() => undefined); } catch { /* searching is a convenience: it never stops a conversation */ }
    }, this.kind === "agent" ? this.project : () => undefined);
  }

  /** The first time, everything already kept is put into the index. */
  fill(db: SearchIndex): void {
    if (!db.empty) return;
    const store = new FileSessionStore(this.storeDir), journal = this.journal();
    for (const s of journal.list(500)) { const items = journal.items(s.id); if (items) db.put(s.id, s.title, s.updated, items); }
    for (const s of store.list(500)) { if (journal.items(s.id)) continue; const m = store.load(s.id); if (m) db.put(s.id, s.title, s.updated, historyOf(m, 400)); }
  }

  /** The Recall tool's view: the conversations before this one, so `current` (the one being had) is never listed among them. */
  recall(current: () => string | undefined): Recall {
    const ready = (): SearchIndex | undefined => { const db = this.index; if (db) this.fill(db); return db; };
    const others = <T extends { id: string }>(rows: T[], limit: number): T[] => rows.filter((r) => r.id !== current()).slice(0, limit);
    return {
      search: async (query, limit) => {
        const db = ready();
        if (!db) return [];
        const meaning = this.meaning, wide = (limit + 1) * (meaning ? 3 : 1);
        const hits = db.search(query, wide), byWords = hits.length ? hits : db.search(query, wide, true);
        return others(meaning ? await withMeaning(db, meaning, query, byWords, limit + 1) : byWords, limit);
      },
      notice: () => this.meaning?.notice(),
      read: (id) => { const items = this.journal().items(id); if (items) return items; const m = new FileSessionStore(this.storeDir).load(id); return m ? historyOf(m, 400) : undefined; },
      recent: (limit) => { const db = ready(); return db ? others(db.recent(limit + 1), limit) : []; },
    };
  }

  close(): void {
    this.#closed = true;
    const open = this.#index;
    this.#index = undefined;
    try { open?.close(); } catch { return; }
  }
}
