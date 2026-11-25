/**
 * The words a person uses to say "this is my password", by language, and the little words that link one to its value ("password is x", "sandi: x").
 * Data on purpose, like the brand names: a secret typed in any language is told about, and the words of other languages stay in this one file
 * (the language test skips it, with that reason). Add a language here, not in the code that reads it.
 */
export const PASSWORD_WORDS: Record<string, readonly string[]> = {
  en: ["password", "passphrase", "passwd", "pwd", "secret", "token"],
  id: ["kata sandi", "sandi", "kata kunci"],
  es: ["contraseña", "contrasena", "clave"],
  pt: ["palavra-passe", "senha"],
  fr: ["mot de passe", "mdp"],
  de: ["passwort", "kennwort"],
  ru: ["пароль"],
  zh: ["密码", "口令"],
  ja: ["パスワード", "暗証番号"],
  hi: ["पासवर्ड"],
  ar: ["كلمة المرور", "كلمة السر"],
};

/** What may stand between the word and the value. */
export const LINK_WORDS: readonly string[] = ["is", "are", "es", "é", "est", "ist", "adalah", "nya", "это", "是", "は", "है", "هي", "=", ":", "：", "-", "—"];
