/**
 * Matching that is a little looser than the same word: letters folded to lowercase without accents, languages written without spaces
 * cut into pairs of characters, and a word that is one slip away from another taken for it. No model, no index of its own: the notes and the
 * search of earlier conversations both use it. It does not know that two words mean the same; see `embeddings.ts` for that.
 */

const DENSE_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Lowercase, and without accents on Latin and Greek letters ("Café" is "cafe"); other scripts keep their marks, which carry the vowels. */
export const fold = (text: string): string => text.normalize("NFD").replace(/(?<=[\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu, "").normalize("NFC").toLowerCase();

/** The words of a text, folded. */
export const wordsOf = (text: string): string[] => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether a text holds Chinese or Japanese, which have no spaces between words. */
export const isDense = (text: string): boolean => DENSE_RUN.test(text);

/** The words of a text as terms to compare: a run of Chinese or Japanese characters becomes the pairs of neighbours in it, since words cannot be told apart. */
export function terms(text: string): string[] {
  return wordsOf(text).flatMap((w) => {
    if (!isDense(w)) return [w];
    const chars = [...w];
    return chars.length < 2 ? [w] : chars.slice(1).map((c, i) => chars[i]! + c);
  });
}

/** How many single changes (a letter added, dropped, changed, or two swapped) turn one word into the other, or `limit + 1` when it is more than `limit`. */
export function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, before[j - 2]! + 1);
      next.push(best);
    }
    before = row;
    row = next;
  }
  return row[b.length]!;
}

/** How many slips a word of this length may have and still be taken for another: none for a short word, or one with a digit (topic2 and topic4 are two things), which a slip would turn into a different one. */
export const slips = (word: string): number => (/\p{N}/u.test(word) ? 0 : word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0);

/** The word of `vocabulary` closest to this one, when it is within the slips allowed (the commoner of two equal ones comes first in `vocabulary`). */
export function closest(word: string, vocabulary: Iterable<string>): string | undefined {
  const limit = slips(word);
  if (!limit) return undefined;
  let best: string | undefined, at = limit + 1;
  for (const v of vocabulary) {
    const d = distance(word, v, Math.min(limit, at - 1));
    if (d < at && d > 0) { best = v; at = d; if (d === 1) break; }
  }
  return best;
}

/** Whether a word of a request is the same as a word of a text, or the start of it (a word of four letters or more), or one slip away from it. */
export function alike(asked: string, word: string): boolean {
  if (asked === word) return true;
  if (asked.length >= 4 && word.length >= 4 && (word.startsWith(asked) || asked.startsWith(word))) return true;
  return asked.length >= 5 && distance(asked, word, slips(asked)) <= slips(asked);
}
