import { describe, expect, test } from "bun:test";
import { extractByRules } from "../src/index.ts";
import { MEMORY_WORDS } from "../src/memory-words.ts";

const found = (text: string) => extractByRules([{ n: 1, text }]).map((p) => `${p.scope}: ${p.text}`);

/** One row per language: a name, a rule, "from now on", "remember that", a preference, "we use"; a sentence that must give nothing; a sentence about a password that must give nothing. */
const ROWS: Record<string, { name: [string, string]; rule: string; now: [string, string]; remember: [string, string]; prefer: string; we: string; none: string; secret: string }> = {
  id: { name: ["Nama saya Dewi Lestari", "Dewi Lestari"], rule: "Selalu pakai tab di repo ini", now: ["Mulai sekarang tulis komentar singkat", "Tulis komentar singkat"], remember: ["Ingat bahwa build dijalankan dengan bun", "Build dijalankan dengan bun"], prefer: "Saya lebih suka jawaban yang singkat", we: "Kami menggunakan pnpm untuk instalasi", none: "Tolong perbaiki tes yang gagal itu", secret: "Selalu pakai kata sandi Zx9kQ7mPw untuk database" },
  es: { name: ["Me llamo Lucía Gómez", "Lucía Gómez"], rule: "Siempre usa tabuladores en este repositorio", now: ["A partir de ahora escribe comentarios cortos", "Escribe comentarios cortos"], remember: ["Recuerda que el build usa bun", "El build usa bun"], prefer: "Prefiero respuestas cortas y directas", we: "Usamos pnpm para las instalaciones", none: "Por favor arregla la prueba que falla", secret: "Siempre usa la contraseña Zx9kQ7mPw en la base" },
  pt: { name: ["Meu nome é Ana Souza", "Ana Souza"], rule: "Sempre use tabs neste repositório", now: ["A partir de agora escreva comentários curtos", "Escreva comentários curtos"], remember: ["Lembre-se de que o build usa bun", "O build usa bun"], prefer: "Eu prefiro respostas curtas e diretas", we: "Usamos pnpm para as instalações", none: "Por favor corrija o teste que falha", secret: "Sempre use a senha Zx9kQ7mPw no banco" },
  fr: { name: ["Je m'appelle Claire Martin", "Claire Martin"], rule: "Toujours utiliser des tabulations dans ce dépôt", now: ["À partir de maintenant écris des commentaires courts", "Écris des commentaires courts"], remember: ["Souviens-toi que le build utilise bun", "Le build utilise bun"], prefer: "Je préfère des réponses courtes et directes", we: "Nous utilisons pnpm pour les installations", none: "Corrige le test qui échoue s'il te plaît", secret: "Toujours utiliser le mot de passe Zx9kQ7mPw pour la base" },
  de: { name: ["Ich heiße Jana Becker", "Jana Becker"], rule: "Immer Tabs benutzen, keine Leerzeichen", now: ["Ab sofort schreibe kurze Kommentare", "Schreibe kurze Kommentare"], remember: ["Denk daran, dass der Build bun benutzt", "Der Build bun benutzt"], prefer: "Ich bevorzuge kurze und direkte Antworten", we: "Wir verwenden pnpm für die Installation", none: "Bitte repariere den fehlgeschlagenen Test", secret: "Immer das Passwort Zx9kQ7mPw für die Datenbank benutzen" },
  ru: { name: ["Меня зовут Анна Иванова", "Анна Иванова"], rule: "Всегда используй табы в этом репозитории", now: ["С этого момента пиши короткие комментарии", "Пиши короткие комментарии"], remember: ["Запомни, что сборка использует bun", "Сборка использует bun"], prefer: "Я предпочитаю короткие и прямые ответы", we: "Мы используем pnpm для установки", none: "Пожалуйста, исправь упавший тест", secret: "Всегда используй пароль Zx9kQ7mPw для базы" },
  zh: { name: ["我叫李明", "李明"], rule: "总是在这个仓库使用制表符", now: ["从现在开始写简短的注释", "写简短的注释"], remember: ["请记住构建使用bun", "构建使用bun"], prefer: "我更喜欢简短直接的回答", we: "我们使用pnpm安装依赖", none: "请修复失败的测试", secret: "总是使用密码Zx9kQ7mPw连接数据库" },
  ja: { name: ["私の名前は田中です", "田中"], rule: "必ずこのリポジトリではタブを使う", now: ["今後は短いコメントを書く", "短いコメントを書く"], remember: ["ビルドにbunを使うことを覚えておいてください", "ビルドにbunを使う"], prefer: "短くて直接的な答えの方が好き", we: "私たちはインストールにpnpmを使っています", none: "失敗しているテストを直してください", secret: "必ずパスワードZx9kQ7mPwをデータベースに使う" },
  hi: { name: ["मेरा नाम दीपक शर्मा है", "दीपक शर्मा"], rule: "हमेशा इस रिपॉज़िटरी में टैब इस्तेमाल करें", now: ["अब से छोटे कमेंट लिखो", "छोटे कमेंट लिखो"], remember: ["याद रखो कि बिल्ड bun इस्तेमाल करता है", "बिल्ड bun इस्तेमाल करता है"], prefer: "मुझे पसंद है छोटे और सीधे जवाब", we: "हम इंस्टॉल के लिए pnpm इस्तेमाल करते हैं", none: "कृपया फेल होने वाला टेस्ट ठीक करो", secret: "हमेशा पासवर्ड Zx9kQ7mPw डेटाबेस के लिए इस्तेमाल करें" },
  ar: { name: ["اسمي سارة أحمد", "سارة أحمد"], rule: "دائما استخدم علامات التبويب في هذا المستودع", now: ["من الآن فصاعدا اكتب تعليقات قصيرة", "اكتب تعليقات قصيرة"], remember: ["تذكر أن البناء يستخدم bun", "البناء يستخدم bun"], prefer: "أفضل الإجابات القصيرة والمباشرة", we: "نحن نستخدم pnpm للتثبيت", none: "من فضلك أصلح الاختبار الفاشل", secret: "دائما استخدم كلمة السر Zx9kQ7mPw للقاعدة" },
};

describe("statements in other languages become notes, from the data file", () => {
  test("there is a row of this test for every language of the data", () => {
    expect(Object.keys(ROWS).sort()).toEqual(Object.keys(MEMORY_WORDS).sort());
  });
  for (const [lang, row] of Object.entries(ROWS)) {
    describe(lang, () => {
      test("a name, for every project", () => { expect(found(row.name[0])).toEqual([`user: The person's name is ${row.name[1]}`]); });
      test("a rule, a preference and a way of working are kept as said", () => {
        expect(found(row.rule)).toEqual([`project: ${row.rule}`]);
        expect(found(row.prefer)).toEqual([`user: ${row.prefer}`]);
        expect(found(row.we)).toEqual([`project: ${row.we}`]);
      });
      test("from now on and remember that keep what follows", () => {
        expect(found(row.now[0])).toEqual([`project: ${row.now[1]}`]);
        expect(found(row.remember[0])).toEqual([`project: ${row.remember[1]}`]);
      });
      test("a plain request, a question and a password give nothing", () => {
        expect(found(row.none)).toEqual([]);
        expect(found(`${row.rule}?`)).toEqual([]);
        expect(found(row.secret)).toEqual([]);
      });
    });
  }
  test("a statement in the middle of several sentences, and at most three per turn", () => {
    expect(found("Hola. Siempre usa tabuladores en este repositorio. Gracias")).toEqual(["project: Siempre usa tabuladores en este repositorio"]);
    expect(found("我们使用pnpm。我们使用bun。我们使用vite。我们使用node。")).toHaveLength(3);
  });
  test("English is still read, including remember that", () => {
    expect(found("Remember that the build uses bun")).toEqual(["project: The build uses bun"]);
  });
  test("Indonesian as it is written, with slang and short forms, is kept without its chat filler", () => {
    expect(found("Jgn pernah pake var di repo ini")).toEqual(["project: Jgn pernah pake var di repo ini"]);
    expect(found("mulai skrg tulis komentar singkat ya")).toEqual(["project: Tulis komentar singkat"]);
    expect(found("inget kalo build jalan pake bun dong")).toEqual(["project: Build jalan pake bun"]);
    expect(found("gue suka jawaban singkat")).toEqual(["user: Gue suka jawaban singkat"]);
    expect(found("kita pake bun di sini")).toEqual(["project: Kita pake bun di sini"]);
    expect(found("tolong benerin tes yg gagal dong")).toEqual([]);
  });
});
