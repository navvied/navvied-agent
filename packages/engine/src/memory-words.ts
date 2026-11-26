/**
 * The sentences a person uses to state a lasting fact ("always use tabs", "my name is …", "from now on …", "we use …", "remember that …"), by language,
 * apart from English, which is in `memory-extract.ts`. Data on purpose, like `password-words.ts`: the words of other languages stay in this one file
 * (the language test skips it, with that reason) and the extractor builds its patterns from it. Add a language here, not in the code that reads it.
 *
 * A phrase is lowercase. A space may be a comma and a space; `…` stands for a gap that the sentence fills (a clause that comes before or inside the
 * phrase, as in Japanese or Hindi). Every list is tried at the start of a sentence, after an optional polite word, except `name`, which may stand
 * anywhere in it: a statement is never taken from the middle of another sentence. `prefer` holds what a person says of their own taste; a request
 * ("I want you to …") is a task and has no place in it.
 */
export interface Phrases {
  /** Written without spaces between words (Chinese, Japanese): phrases need no word boundary and a note may be short. */
  dense?: true;
  /** Has no capital letters: a name is not told by its first letter. */
  caseless?: true;
  /** Words that may come before a statement ("please"). */
  polite?: readonly string[];
  /** "my name is": what follows is the name. */
  name: readonly string[];
  /** What closes a sentence that gives a name and is not part of it (the verb of Hindi, "desu" of Japanese). */
  nameEnd?: readonly string[];
  /** "always", "never", "do not use": the sentence itself becomes the note. */
  rule: readonly string[];
  /** "from now on": what follows is the note. */
  now: readonly string[];
  /** "remember that": what follows is the note. */
  remember: readonly string[];
  /** "I prefer": a note for every project, the sentence itself. */
  prefer: readonly string[];
  /** "we use": the sentence itself becomes the note. */
  we: readonly string[];
  /** Words that carry no fact and are dropped from the end of a note ("please", "keep that in mind", "thanks"). */
  filler: readonly string[];
  /** The words that make a sentence about a key, a token or a secret, besides the words for a password (`password-words.ts`): such a sentence is never taken. */
  secret: readonly string[];
}

export const MEMORY_WORDS: Record<string, Phrases> = {
  id: {
    polite: ["tolong", "tlg", "mohon"],
    name: ["nama saya adalah", "nama saya", "namaku adalah", "namaku", "panggil saya", "panggil aku"],
    rule: ["selalu", "jangan pernah", "tidak pernah", "jangan gunakan", "jangan pakai", "jangan tambah", "jangan tambahkan", "jangan ubah", "jangan hapus", "jangan jalankan", "jangan edit", "jangan sentuh", "jangan commit", "jgn pernah", "jgn pake", "jgn pakai", "jangan pake", "slalu"],
    now: ["mulai sekarang", "mulai saat ini", "ke depannya", "selanjutnya", "mulai skrg", "mulai skarang", "mulai dari sekarang"],
    remember: ["ingat bahwa", "ingat kalau", "ingatlah bahwa", "catat bahwa", "inget bahwa", "inget kalo", "inget kalau", "ingat kalo", "catet bahwa"],
    prefer: ["saya lebih suka", "aku lebih suka", "saya suka", "aku suka", "gue suka", "gw suka", "gue lebih suka", "gw lebih suka"],
    we: ["kami menggunakan", "kami memakai", "kami pakai", "kita menggunakan", "kita memakai", "kita pakai", "kami memilih", "kami memutuskan", "kami menjalankan", "kita pake", "kami pake"],
    filler: ["tolong", "mohon", "ingat itu", "ingat ya", "terima kasih", "makasih", "ya", "dong", "deh"],
    secret: ["kunci api", "rahasia", "kredensial", "kunci pribadi", "token"],
  },
  es: {
    polite: ["por favor"],
    name: ["me llamo", "mi nombre es", "llámame", "llamame"],
    rule: ["siempre", "nunca", "no uses", "no utilices", "no agregues", "no añadas", "no edites", "no toques", "no borres", "no elimines", "no ejecutes", "no cambies"],
    now: ["a partir de ahora", "de ahora en adelante", "en adelante"],
    remember: ["recuerda que", "ten en cuenta que", "anota que"],
    prefer: ["prefiero", "me gusta"],
    we: ["usamos", "utilizamos", "elegimos", "decidimos", "desplegamos con", "desplegamos en", "mantenemos"],
    filler: ["por favor", "ten eso en cuenta", "tenlo en cuenta", "recuérdalo", "gracias"],
    secret: ["clave api", "clave privada", "secreto", "credencial", "token"],
  },
  pt: {
    polite: ["por favor"],
    name: ["meu nome é", "me chamo", "pode me chamar de", "chame-me de"],
    rule: ["sempre", "nunca", "não use", "não utilize", "não adicione", "não edite", "não toque", "não apague", "não exclua", "não execute", "não altere", "não mude"],
    now: ["a partir de agora", "de agora em diante", "daqui para frente", "daqui pra frente"],
    remember: ["lembre-se de que", "lembre-se que", "lembre que", "anote que"],
    prefer: ["eu prefiro", "prefiro", "eu gosto de", "gosto de"],
    we: ["nós usamos", "usamos", "nós utilizamos", "utilizamos", "escolhemos", "decidimos", "fazemos deploy com", "fazemos deploy em", "mantemos"],
    filler: ["por favor", "tenha isso em mente", "lembre-se disso", "obrigado", "obrigada"],
    secret: ["chave de api", "chave privada", "segredo", "credencial", "credenciais", "token"],
  },
  fr: {
    polite: ["s'il te plaît", "s'il vous plaît", "veuillez"],
    name: ["je m'appelle", "mon nom est", "appelez-moi", "appelle-moi"],
    rule: ["toujours", "jamais", "n'utilise pas", "n'utilisez pas", "n'ajoute pas", "ne modifie pas", "ne touche pas", "ne supprime pas", "ne lance pas", "n'exécute pas", "ne change pas", "ne commit pas"],
    now: ["à partir de maintenant", "désormais", "dorénavant", "à l'avenir"],
    remember: ["souviens-toi que", "souvenez-vous que", "rappelle-toi que", "retiens que", "note que"],
    prefer: ["je préfère", "j'aime"],
    we: ["nous utilisons", "on utilise", "nous avons choisi", "nous avons décidé de", "nous déployons avec", "nous déployons sur", "nous gardons"],
    filler: ["s'il te plaît", "s'il vous plaît", "souviens-toi de ça", "garde ça en tête", "merci"],
    secret: ["clé api", "clé privée", "secret", "identifiants", "jeton", "token"],
  },
  de: {
    polite: ["bitte"],
    name: ["ich heiße", "ich heisse", "mein name ist", "nenn mich", "nennen sie mich"],
    rule: ["immer", "niemals", "nie", "benutze nie", "verwende nie", "benutze kein", "benutze keine", "verwende kein", "verwende keine", "benutze nicht", "verwende nicht", "ändere nicht", "lösche nicht", "berühre nicht", "committe nicht", "führe nicht"],
    now: ["ab sofort", "von jetzt an", "in zukunft", "künftig", "zukünftig"],
    remember: ["denk daran dass", "merk dir dass", "beachte dass", "bedenke dass"],
    prefer: ["ich bevorzuge", "ich mag", "ich möchte lieber", "ich will lieber"],
    we: ["wir verwenden", "wir benutzen", "wir nutzen", "wir haben uns für", "wir haben beschlossen", "wir deployen mit", "wir deployen auf", "wir behalten"],
    filler: ["bitte", "merk dir das", "denk daran", "danke"],
    secret: ["api-schlüssel", "privater schlüssel", "geheimnis", "zugangsdaten", "token"],
  },
  ru: {
    polite: ["пожалуйста"],
    name: ["меня зовут", "моё имя", "мое имя", "зовите меня", "называй меня"],
    rule: ["всегда", "никогда", "не используй", "не используйте", "не добавляй", "не редактируй", "не трогай", "не удаляй", "не запускай", "не меняй", "не коммить"],
    now: ["с этого момента", "отныне", "впредь", "в будущем"],
    remember: ["запомни что", "помни что", "учти что", "имей в виду что"],
    prefer: ["я предпочитаю", "мне нравится", "я люблю"],
    we: ["мы используем", "мы пользуемся", "мы выбрали", "мы решили", "мы деплоим на", "мы деплоим через", "мы храним"],
    filler: ["пожалуйста", "запомни это", "учти это", "помни об этом", "спасибо"],
    secret: ["токен", "секрет", "api-ключ", "ключ api", "учетные данные", "учётные данные", "закрытый ключ"],
  },
  zh: {
    dense: true,
    caseless: true,
    polite: ["请"],
    name: ["我叫", "我的名字是", "我的名字叫", "叫我"],
    rule: ["总是", "永远不要", "永远", "绝不要", "千万不要", "不要使用", "不要用", "不要添加", "不要修改", "不要编辑", "不要删除", "不要运行", "不要提交", "不要碰"],
    now: ["从现在开始", "从今以后", "今后", "以后"],
    remember: ["记住", "记得"],
    prefer: ["我更喜欢", "我喜欢", "我偏好"],
    we: ["我们使用", "我们用", "我们选择了", "我们决定", "我们部署到", "我们部署在", "我们保留"],
    filler: ["请记住这一点", "记住这一点", "请记住", "记住这个", "谢谢", "请"],
    secret: ["密钥", "令牌", "秘密", "凭证", "私钥"],
  },
  ja: {
    dense: true,
    caseless: true,
    nameEnd: ["です", "といいます", "と申します", "と言います", "だよ"],
    name: ["私の名前は", "わたしの名前は", "僕の名前は", "名前は"],
    rule: ["いつも", "常に", "必ず", "絶対に", "決して", "…しないでください", "…しないで下さい", "…してはいけません"],
    now: ["今後は", "これからは", "以後は", "今から"],
    remember: ["…ことを覚えておいてください", "…ことを覚えておいて", "…を覚えておいてください", "…を覚えておいて", "…ことを忘れないで"],
    prefer: ["…の方が好き", "…が好きです"],
    we: ["私たちは", "我々は", "うちでは", "チームでは"],
    filler: ["覚えておいてください", "覚えておいて", "お願いします", "ありがとう"],
    secret: ["トークン", "シークレット", "秘密鍵", "認証情報", "apiキー"],
  },
  hi: {
    caseless: true,
    polite: ["कृपया"],
    nameEnd: ["है", "हैं"],
    name: ["मेरा नाम", "मुझे बुलाओ", "मुझे बुलाइए"],
    rule: ["हमेशा", "कभी नहीं", "कभी भी नहीं", "… मत करो", "… न करें", "… मत करें"],
    now: ["अब से", "आज से", "आगे से", "भविष्य में"],
    remember: ["याद रखो कि", "याद रखें कि", "ध्यान रखो कि", "ध्यान रखें कि"],
    prefer: ["मुझे पसंद है", "मैं पसंद करता हूँ", "मैं पसंद करता हूं", "मैं पसंद करती हूँ", "मैं पसंद करती हूं"],
    we: ["हम … इस्तेमाल करते हैं", "हम … उपयोग करते हैं", "हमने … चुना", "हमने … तय किया"],
    filler: ["कृपया", "यह याद रखना", "याद रखना", "धन्यवाद"],
    secret: ["टोकन", "गोपनीय", "एपीआई कुंजी", "क्रेडेंशियल", "गुप्त"],
  },
  ar: {
    caseless: true,
    polite: ["من فضلك", "رجاء", "لو سمحت"],
    name: ["اسمي هو", "اسمي", "ناديني", "نادني"],
    rule: ["دائما", "دائماً", "أبدا", "أبداً", "لا تستخدم", "لا تضف", "لا تعدل", "لا تلمس", "لا تحذف", "لا تشغل", "لا تغير"],
    now: ["من الآن فصاعدا", "من الآن فصاعداً", "من الآن", "في المستقبل"],
    remember: ["تذكر أن", "تذكر ان", "اعلم أن", "لاحظ أن"],
    prefer: ["أنا أفضل", "أفضل", "يعجبني", "أحب"],
    we: ["نحن نستخدم", "نستخدم", "اخترنا", "قررنا"],
    filler: ["من فضلك", "تذكر ذلك", "رجاء", "شكرا"],
    secret: ["الرمز المميز", "توكن", "سري", "مفتاح api", "بيانات الاعتماد", "المفتاح الخاص"],
  },
};
