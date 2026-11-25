/**
 * The words for "each", "every" and "all" in the languages people write requests in: a cue that a request is about many things, never a requirement.
 * Data on purpose, like the words for "password": the words of other languages stay in files like this one (the language test skips it, with that reason).
 */
export const EVERY_WORDS: Record<string, readonly string[]> = {
  en: ["each", "every", "all", "per"],
  id: ["setiap", "tiap", "seluruh", "semua"],
  es: ["cada", "todos", "todas"],
  fr: ["chaque", "tous", "toutes"],
  de: ["jede", "jeden", "jedem", "jeder", "jedes", "alle"],
  it: ["ogni", "tutti"],
  ru: ["все", "каждый", "каждую"],
  zh: ["每", "各", "全部", "所有"],
  ja: ["すべて", "全て"],
  ko: ["모든"],
  ar: ["كل"],
};
