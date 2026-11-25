/** The pages of the paginated API of the multi-call task, made from the run's secret: the server serves them, the check works out what was asked for again. */
import { createHash } from "node:crypto";

export interface Item { id: number; name: string; score: number }
export const PAGES = 12;
const PER_PAGE = 10;

const digest = (secret: string, part: string): string => createHash("sha1").update(`${secret}api${part}`).digest("hex");

export const items = (secret: string): Item[] => Array.from({ length: PAGES * PER_PAGE }, (_, i) => { const d = digest(secret, String(i)); return { id: i + 1, name: d.slice(0, 8), score: parseInt(d.slice(8, 12), 16) % 1000 }; });
/** The token in the address of the page after page `page` (the first page has none), so the pages are reached only by following links. */
export const cursor = (secret: string, page: number): string => digest(secret, `cursor${page}`).slice(0, 10);
export const onPage = (secret: string, page: number): Item[] => items(secret).slice(page * PER_PAGE, (page + 1) * PER_PAGE);
/** What the task asks for: every item, the highest score first, equal scores by id. */
export const wanted = (secret: string): Item[] => [...items(secret)].sort((a, b) => b.score - a.score || a.id - b.id);
