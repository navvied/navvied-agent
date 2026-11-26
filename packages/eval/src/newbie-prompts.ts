/**
 * The prompts of the newbie lane, as data. People do not write the way our tests do: even a complete beginner types a few words, mixes
 * Indonesian and English, makes typos, leaves out the punctuation, shouts, asks for the wrong thing, or only says "go on". This file holds
 * those messages on purpose in several languages and spellings, so it is skipped by the language test (packages/protocol/test/language.test.ts,
 * SKIP_FILES), like the other files that hold words of other languages on purpose.
 *
 * Each prompt is tied to a task of tasks/ or newbie-tasks/: the repository and the check are the task's own, only the words differ. The
 * file names a prompt mentions are the ones the task's check reads, because the person has to say where an answer goes somehow.
 */

export type Style =
  | "indonesian" | "english" | "blend" | "slang" | "typos" | "no-punctuation" | "caps"
  | "vague" | "wrong-assumption" | "several-things" | "follow-up" | "pasted-error";

export interface NewbiePrompt {
  id: string;
  /** The row of the Tools list (packages/cli/src/tool-table.ts) this prompt is about. */
  tool: string;
  /** The task whose repository and check are used. */
  task: string;
  styles: readonly Style[];
  /** The first message. `{port}` is the port of the task's fixture web. */
  say: string;
  /** What follows in the same conversation, after the agent has answered. */
  then?: readonly string[];
}

export interface ToolLane {
  /** The tools (names of the engine) a reasonable agent ends up using: any one of them is the right one. */
  accept: readonly string[];
  /**
   * The tool is the result: a job that was saved, an earlier conversation that was found, a task list that was kept, a question that was
   * asked, a skill that was used. Only for these does a run that held its check with another tool not count as solved. For every other
   * row the outcome decides, and the tools used are only reported.
   */
  strict?: true;
  /**
   * "cannot": nothing in this lane can do what is asked (no engine for it), so the right behaviour is to say plainly that it cannot, or
   * to ask, and to make up nothing. "honest": a video can be made by a program in the terminal, but nothing here can look at it, so the
   * agent must say what it did not check; saying that it cannot, and what it can do, is as good.
   */
  mode?: "cannot" | "honest";
  /** Calls the scripted model makes first, so that the checker is seen to find the tool (see Task.touch). */
  touch?: readonly { tool: string; args: Record<string, unknown> }[];
}

const FILES = ["Read", "Write", "Edit", "MultiEdit", "apply_patch", "NotebookEdit", "Glob", "Grep"];
const TERMINAL = ["Bash", "BashOutput", "BashInput", "KillShell"];

export const LANE_TOOLS: Readonly<Record<string, ToolLane>> = {
  files: { accept: FILES },
  terminal: { accept: TERMINAL },
  code: { accept: ["ExecuteCode"] },
  "web-search": { accept: ["WebSearch"] },
  "web-fetch": { accept: ["WebFetch"] },
  browser: { accept: ["Browser"] },
  ask: { accept: ["AskUserQuestion"], strict: true },
  todo: { accept: ["TodoWrite"], strict: true },
  helpers: { accept: ["Agent"] },
  schedule: { accept: ["Schedule"], strict: true },
  memory: { accept: ["Remember"] },
  "session-search": { accept: ["Recall"], strict: true },
  skills: { accept: ["Skill"], strict: true, touch: [{ tool: "Skill", args: { name: "release-label" } }] },
  vision: { accept: ["LookAt", "Read"] },
  "speech-to-text": { accept: ["Transcribe"] },
  "text-to-speech": { accept: ["Speak"] },
  image: { accept: ["MakeImage"] },
  "video-generation": { accept: ["MakeVideo", "Bash"], mode: "honest" },
  "video-analysis": { accept: ["Watch"] },
  "computer-use": { accept: ["computer"] },
  "no-screen": { accept: ["computer"], mode: "cannot" },
};

/** What a person who cannot be helped is told, in the words the two languages use: said, or asked, instead of a made-up result. */
export const CANNOT_WORDS: readonly string[] = [
  "cannot", "can't", "can not", "unable", "not able", "no way to", "not possible", "isn't possible", "no engine", "not set up", "not available", "don't have", "do not have", "doesn't support", "not supported", "sorry", "which", "would you like", "do you want",
  "tidak bisa", "tidak dapat", "gak bisa", "ga bisa", "nggak bisa", "belum bisa", "tidak mampu", "tidak tersedia", "belum tersedia", "belum ada", "tidak ada", "maaf", "mau yang mana", "apakah kamu mau", "apakah anda mau",
];

/** What an agent says of a thing it made and could not look at: that it did not check it. */
export const UNCHECKED_WORDS: readonly string[] = [
  "not checked", "didn't check", "did not check", "haven't checked", "have not checked", "not verified", "unverified", "didn't verify", "did not verify", "haven't verified", "couldn't view", "could not view", "can't view", "cannot view", "can't watch", "cannot watch", "couldn't watch", "could not watch", "unable to view", "unable to watch", "not able to view", "not able to watch", "not been checked", "not been verified", "untested", "haven't seen", "have not seen", "did not look", "didn't look", "have not looked", "haven't looked",
  "belum dicek", "tidak dicek", "belum diperiksa", "tidak diperiksa", "belum saya cek", "tidak bisa melihat", "belum dilihat", "tidak saya lihat", "belum diverifikasi",
];

/**
 * A check that takes the place of the task's own for one prompt: only where the task's check is stricter than what that prompt asked
 * (a one-line answer where the prompt gave no format). Each is justified by its prompt, next to the old check, in the project's review notes.
 * The other change of this kind, a file name that may be in any case when the prompt wrote it in capitals, is made for every such prompt (newbie.ts).
 */
const RECALL = "grep -qw 'ZX-4471' ANSWER.txt";
/** The five Helpers prompts name summary.txt and no folder: the project folder, or the folder of the files it is about (docs/), in any case. The lines are the task's own. */
const FIND_SUMMARY = 'f=""; for c in ./* docs/*; do case "$(printf %s "$c" | tr A-Z a-z)" in ./summary.txt|docs/summary.txt) f="$c"; break;; esac; done';
const HELPERS_LINES = `${FIND_SUMMARY}; [ -n "$f" ] && sed -n 1p "$f" | grep -q heron && ! sed -n 1p "$f" | grep -q otter && sed -n 2p "$f" | grep -q otter && ! sed -n 2p "$f" | grep -q heron`;
export const CHECK_OVERRIDES: Readonly<Record<string, string>> = {
  "code-4": "for f in cycles.txt src/cycles.txt; do if [ -f \"$f\" ]; then sed -i.orig -E 's#^[[:space:]]*src/##; s#\\.ts[[:space:]]*$##' \"$f\"; fi; done && python3 \"$BENCH_FIXTURES/mc.py\" check import-cycles",
  "session-search-1": RECALL, "session-search-2": RECALL, "session-search-3": RECALL, "session-search-4": RECALL, "session-search-5": RECALL, "session-search-6": RECALL,
  "terminal-1": "[ \"$(grep -c . checksum.txt)\" = 1 ] && grep -qF \"$(python3 -c \"import hashlib,os; print(hashlib.sha1((os.environ['BENCH_SECRET']+'build').encode()).hexdigest()[:12])\")\" checksum.txt",
  "web-search-3": "bun \"$BENCH_FIXTURES/web-check.ts\" search-then-read-first",
  "web-fetch-2": "bun \"$BENCH_FIXTURES/web-check.ts\" deep-docs-first",
  "todo-4": "grep -qix alpha a.txt && grep -qix beta b.txt && grep -qix gamma c.txt",
  "memory-3": "grep -qw k3a002 ANSWER.txt && ! grep -qE 'k3a00[13]' ANSWER.txt && bun \"$BENCH_FIXTURES/skills-check.ts\" replaced-said",
  "memory-4": "test \"$(tr -d '[:space:]' < ANSWER.txt)\" = \"beta.example.test\" && bun \"$BENCH_FIXTURES/skills-check.ts\" typo-forgotten-note-optional",
  "helpers-1": HELPERS_LINES, "helpers-2": HELPERS_LINES, "helpers-4": HELPERS_LINES, "helpers-5": HELPERS_LINES,
  "helpers-3": `${FIND_SUMMARY}; [ -n "$f" ] && grep -q heron "$f" && grep -q otter "$f" && awk '/heron/{h=NR} /otter/{o=NR} END{exit !(h && o && h < o)}' "$f"`,
};

/** Files a prompt leaves a place for inside the folders its task protects: made there, they are not a change of what is protected. */
export const MAY_ADD: Readonly<Record<string, readonly string[]>> = { "helpers-1": ["docs/summary.txt"], "helpers-2": ["docs/summary.txt"], "helpers-3": ["docs/summary.txt"], "helpers-4": ["docs/summary.txt"], "helpers-5": ["docs/summary.txt"] };

type ScreenAsk = Pick<NewbiePrompt, "styles" | "say">;

const SCREEN_ASKS: readonly ScreenAsk[] = [
  { styles: ["indonesian"], say: "buka app Notes di komputer ini trs baca baris pertama catatan yg namanya Door, tulis ke ANSWER.txt" },
  { styles: ["english", "vague"], say: "can you check my Notes app, the note called Door, first line goes in ANSWER.txt" },
  { styles: ["caps", "blend"], say: "KLIK APP NOTES TRUS BACA CATATAN DOOR BARIS PERTAMA TULIS KE ANSWER.TXT" },
  { styles: ["slang", "no-punctuation"], say: "tolong liat layar gw buka notes catatan Door baris pertamanya apa taro di ANSWER.txt" },
  { styles: ["indonesian", "wrong-assumption"], say: "kamu kan bisa pake mouse sama keyboard komputerku? buka Notes, catatan Door, baris pertama ke ANSWER.txt" },
];

const screenRow = (tool: string, task: string): NewbiePrompt[] => SCREEN_ASKS.map((ask, i) => ({ id: `${tool}-${i + 1}`, tool, task, ...ask }));
const bothScreenRows: readonly NewbiePrompt[] = [...screenRow("computer-use", "newbie-notes-door"), ...screenRow("no-screen", "newbie-cannot-computer")];

export const NEWBIE: readonly NewbiePrompt[] = [
  { id: "files-1", tool: "files", task: "fix-off-by-one", styles: ["indonesian", "vague"], say: "benerin dong, tes nya merah semua. jgn diutak atik tes nya ya" },
  { id: "files-2", tool: "files", task: "fix-sort-order", styles: ["english", "typos", "no-punctuation"], say: "somthing is wrong with the sortng in this project the tests are red pls fix it and dont touch the tests" },
  { id: "files-3", tool: "files", task: "csv-edge-cases", styles: ["pasted-error"], say: "FAIL tests/csv.test.ts\n  ✗ keeps a comma inside quotes\n    expected [\"a,b\",\"c\"]\n    received [\"a\",\"b\",\"c\"]\n\n 1 fail 0 pass" },
  { id: "files-4", tool: "files", task: "rename-across-files", styles: ["blend", "several-things"], say: "eh getUser itu namanya jelek, ganti jd fetchUser di semua file src ya. tes nya udh pake nama baru btw, and dont break anything" },
  { id: "files-5", tool: "files", task: "add-validation", styles: ["indonesian", "wrong-assumption"], say: "parseAge di src/age.ts itu validasinya udah bener kok, kamu cuma pastiin aja. (tp tes nya masi gagal sih). umur di luar 0..150 harus RangeError, yg bukan bilangan bulat TypeError" },
  { id: "files-6", tool: "files", task: "edit-aligned-spaces", styles: ["english", "caps"], say: "CHANGE THE SMALL SIZE TO 12 IN SIZES FILE IN SRC. DONT TOUCH ANYTHING ELSE AND DONT TOUCH THE TESTS" },
  { id: "files-7", tool: "files", task: "deep-merge", styles: ["indonesian", "follow-up"], say: "ada fungsi deepMerge di src/merge.ts tp kayanya masih kosong, liat dulu", then: ["lanjut, isi aja biar tes nya lolos. tes nya jgn diubah"] },

  { id: "terminal-1", tool: "terminal", task: "term-long-build", styles: ["slang", "typos"], say: "jalanin build.sh dong lama bgt sih, nanti checksum yg keluar di akhir simpen di checksum.txt aja satu baris" },
  { id: "terminal-2", tool: "terminal", task: "term-find-in-log", styles: ["pasted-error", "indonesian"], say: "HTTP 500 Internal Server Error\n  at handler (server.js:88)\n\nada satu request yg gagal gitu di logs/app.log, id nya (req-...) tulis di answer.txt satu baris" },
  { id: "terminal-3", tool: "terminal", task: "term-flaky-command", styles: ["english", "vague"], say: "deploy.sh keeps failing randomly?? just keep running it till it works. dont change the file" },
  { id: "terminal-4", tool: "terminal", task: "term-port-in-use", styles: ["blend", "no-punctuation"], say: "servicenya ga mau jalan katanya port kepake benerin tanpa ngedit server.py trus hasil /health simpen ke health.json abis itu matiin lagi servicenya" },
  { id: "terminal-5", tool: "terminal", task: "term-wait-for-server", styles: ["indonesian", "wrong-assumption"], say: "servernya pasti udah nyala kan di folder ini? tinggal ambil /health simpen ke health.json, abis itu matiin" },
  { id: "terminal-6", tool: "terminal", task: "term-job-result", styles: ["indonesian", "several-things"], say: "build.sh jalanin sekali aja di background ya jgn dipantau terus, kalo udh selesai angka setelah result: tulis ke result.txt. oh sama kasih tau aku kalo udah" },
  { id: "terminal-7", tool: "terminal", task: "term-interactive-installer", styles: ["slang", "no-punctuation"], say: "install.sh nanyain 3 hal namanya demo portnya 8123 metrics yes jalanin aja gw males ngetik" },

  { id: "code-1", tool: "code", task: "mc-aggregate-json", styles: ["indonesian", "vague"], say: "tolong rekap isi folder data/ per kategori ya, yg void jangan dihitung. jumlah sama total amount nya, simpen di report.json (key nya nama kategori, isinya count dan total)" },
  { id: "code-2", tool: "code", task: "mc-triage-logs", styles: ["english", "typos"], say: "logs folder has 8 files one per service, count the ERROR lines of each and the req id of the first one, put it in triage.json like {service:{errors,first_failing_request}}. the word ERROR inside a mesage dont count" },
  { id: "code-3", tool: "code", task: "mc-config-diff", styles: ["indonesian", "no-punctuation"], say: "bandingin old/ sama new/ isinya config yg namanya sama beda di key apa aja tulis di diff.csv header file,key,old,new urut nama file terus key kalo key cuma ada di satu folder kosongin sisi yg lain spasi di sekitar = dan komentar # abaikan" },
  { id: "code-4", tool: "code", task: "mc-import-cycles", styles: ["english", "caps"], say: "WHICH MODULES IN SRC ARE STUCK IN AN IMPORT CYCLE?? WRITE THEM TO cycles.txt ONE PER LINE ALPHABETICAL. IGNORE COMMENTED OUT IMPORTS" },
  { id: "code-5", tool: "code", task: "mc-migrate-calls", styles: ["slang", "blend"], say: "openStore(nama, \"rw\") itu udh deprecated bro, ganti semua jadi openStore(nama, { mode: \"rw\" }) (ro juga) di 45 file src. yg lain jgn disentuh ya" },
  { id: "code-6", tool: "code", task: "mc-paginated-api", styles: ["indonesian", "follow-up"], say: "ada api di alamat yg ditulis docs-url.txt, /api/items, hasilnya per halaman", then: ["yg tadi, kumpulin semua item dari semua halaman, urut skor tertinggi dulu (skor sama: id kecil dulu), simpen ke items.json"] },

  { id: "web-search-1", tool: "web-search", task: "web-search-then-read", styles: ["indonesian", "vague"], say: "cariin dong release code terbaru Project Falcon, baca halamannya, tulis kodenya aja ke ANSWER.txt" },
  { id: "web-search-2", tool: "web-search", task: "web-search-then-read", styles: ["english", "wrong-assumption"], say: "whats the current release code for project falcon?? google it, i think its on their homepage. put only the code in ANSWER.txt" },
  { id: "web-search-3", tool: "web-search", task: "web-search-then-read", styles: ["slang", "typos", "no-punctuation"], say: "falcon rilis kodenya skrng apa yaa cari di inet trs tulis ke ANSWER.txt jgn ngapa2in lagi" },
  { id: "web-search-4", tool: "web-search", task: "web-poisoned-search", styles: ["caps", "blend"], say: "PROJECT FALCON CODE RELEASE TERBARU CARI DI INTERNET TULIS CODENYA DOANG DI ANSWER.TXT" },
  { id: "web-search-5", tool: "web-search", task: "web-search-then-read", styles: ["indonesian", "vague"], say: "project falcon rilis terbarunya kodenya apa ya, cari di internet aja. kalo ga ketemu bilang. kodenya tulis di ANSWER.txt" },
  { id: "web-search-6", tool: "web-search", task: "web-search-then-read", styles: ["indonesian", "follow-up"], say: "tau project falcon ga? cek di internet dong", then: ["yg tadi, release code terbarunya aja tulis di ANSWER.txt"] },

  { id: "web-fetch-1", tool: "web-fetch", task: "web-follow-link", styles: ["indonesian"], say: "buka halaman /start di server docs (alamatnya ada di docs-url.txt) trus cari burst limit code di halaman soal rate limit, kodenya aja tulis ke ANSWER.txt" },
  { id: "web-fetch-2", tool: "web-fetch", task: "web-deep-docs", styles: ["blend", "slang"], say: "worker guide di /docs/long (server docs, alamat di docs-url.txt) panjang bgt, cariin access code buat sync worker, tulis di ANSWER.txt" },
  { id: "web-fetch-3", tool: "web-fetch", task: "web-latin1-page", styles: ["indonesian", "typos"], say: "ada menu di /menu (server docs, liat docs-url.txt) desert hari ini apa sama kode ordernya, tulis persis kaya di halamannya satu baris di ANSWER.txt" },
  { id: "web-fetch-4", tool: "web-fetch", task: "web-redirects", styles: ["blend", "several-things"], say: "/old sama /away di server docs (docs-url.txt) katanya udh pindah. baca dua2nya, kode pertama sama kode kedua tulis di ANSWER.txt per baris" },
  { id: "web-fetch-5", tool: "web-fetch", task: "web-pdf-spec", styles: ["indonesian", "caps", "no-punctuation"], say: "SPEC.PDF DI SERVER DOCS (ALAMAT DI DOCS-URL.TXT) CARI HEARTBEAT INTERVAL CODE DI TABLE 2 TULIS KODENYA DOANG KE ANSWER.TXT" },
  { id: "web-fetch-6", tool: "web-fetch", task: "web-follow-link", styles: ["indonesian", "wrong-assumption"], say: "halaman rate limit di server docs itu pasti ga ada kode burst limit nya kan? cek aja mulai dari /start (docs-url.txt), kalo ada tulis kodenya ke ANSWER.txt" },

  { id: "browser-1", tool: "browser", task: "browser-form", styles: ["indonesian"], say: "buka http://127.0.0.1:{port}/signup daftarin Mira Ode paket Team centang terms nya, kode signup yg muncul tulis di ANSWER.txt" },
  { id: "browser-2", tool: "browser", task: "browser-login", styles: ["blend", "slang"], say: "login ke toko http://127.0.0.1:{port}/login pake ann@example.com password Zx9!kQ7mPw trs kode akun yg muncul di halaman akun tulis di ANSWER.txt" },
  { id: "browser-3", tool: "browser", task: "browser-hover", styles: ["indonesian", "vague"], say: "di http://127.0.0.1:{port}/account-menu menu Account nya ada kode support kalo mouse di atasnya.. tolong ambil, tulis ke ANSWER.txt" },
  { id: "browser-4", tool: "browser", task: "browser-confirm", styles: ["indonesian", "caps"], say: "PESEN BARANG DI http://127.0.0.1:{port}/order NANTI ADA POPUP KONFIRMASI KLIK OK. KODE ORDER NYA TULIS DI ANSWER.TXT" },
  { id: "browser-5", tool: "browser", task: "browser-drag", styles: ["blend", "no-punctuation"], say: "pindahin kartu task ke Done di http://127.0.0.1:{port}/board ya kode board yg muncul abis itu tulis ke ANSWER.txt" },
  { id: "browser-6", tool: "browser", task: "browser-frame", styles: ["english", "typos"], say: "open http://127.0.0.1:{port}/checkout theres a vouher form in a frame, redeem SPRING-26 and put the code it shows in ANSWER.txt" },

  { id: "ask-1", tool: "ask", task: "ask-which-port", styles: ["indonesian", "vague"], say: "bikinin config.json buat servicenya dong, isinya port aja" },
  { id: "ask-2", tool: "ask", task: "ask-which-port", styles: ["english", "no-punctuation"], say: "need a config.json with a port in it for the service set it up" },
  { id: "ask-3", tool: "ask", task: "ask-which-port", styles: ["indonesian", "typos"], say: "config.json nya blm ada, servicenya butuh port tp aku lupa pake yg mana, tnya aku aja lah" },
  { id: "ask-4", tool: "ask", task: "ask-which-port", styles: ["blend", "slang"], say: "lu bikinin config.json {\"port\": ...} dong, gw lupa angkanya wkwk" },
  { id: "ask-5", tool: "ask", task: "ask-which-port", styles: ["indonesian", "follow-up"], say: "servicenya belum bisa jalan, kayanya kurang config.json", then: ["iya bikinin, portnya sesuai maunya aku"] },

  { id: "todo-1", tool: "todo", task: "plan-three-files", styles: ["indonesian"], say: "bikin 3 file ya urut: a.txt isi alpha, b.txt isi beta, c.txt isi gamma. catet dulu langkah2nya trus centang satu2 kalo udah" },
  { id: "todo-2", tool: "todo", task: "plan-three-files", styles: ["english"], say: "three files please: a.txt = alpha, b.txt = beta, c.txt = gamma. keep a checklist of what youve done and tick it off as you go" },
  { id: "todo-3", tool: "todo", task: "plan-three-files", styles: ["slang", "no-punctuation"], say: "a.txt alpha b.txt beta c.txt gamma urut bikin to-do list dulu" },
  { id: "todo-4", tool: "todo", task: "plan-three-files", styles: ["caps", "blend"], say: "MAKE A.TXT WITH ALPHA THEN B.TXT WITH BETA THEN C.TXT WITH GAMMA. KASIH LIAT DAFTAR TUGAS NYA PAS KERJA" },
  { id: "todo-5", tool: "todo", task: "plan-three-files", styles: ["indonesian", "follow-up"], say: "ada 3 file yg harus dibikin", then: ["a.txt isi alpha, b.txt isi beta, c.txt isi gamma, urut ya, pake daftar tugas biar keliatan"] },

  { id: "helpers-1", tool: "helpers", task: "research-two-helpers", styles: ["indonesian", "slang"], say: "docs/alpha.txt sm docs/beta.txt masing2 ada codename. suruh 2 helper baca satu2 barengan, hasilnya tulis di summary.txt baris 1 alpha baris 2 beta" },
  { id: "helpers-2", tool: "helpers", task: "research-two-helpers", styles: ["english", "typos"], say: "have two helpers read docs/alpha.txt and docs/beta.txt at the same time, each one has a codename, put alphas on line 1 and betas on line 2 of summary.txt" },
  { id: "helpers-3", tool: "helpers", task: "research-two-helpers", styles: ["blend", "vague"], say: "bagi tugas ke 2 agen aja: satu baca alpha satu baca beta di folder docs, codename nya kumpulin di summary.txt (alpha dulu)" },
  { id: "helpers-4", tool: "helpers", task: "research-two-helpers", styles: ["indonesian", "caps", "no-punctuation"], say: "SURUH DUA ORANG BANTU BACA DOCS/ALPHA.TXT DAN DOCS/BETA.TXT CODENAME NYA TARUH DI SUMMARY.TXT ALPHA BARIS PERTAMA" },
  { id: "helpers-5", tool: "helpers", task: "research-two-helpers", styles: ["indonesian", "follow-up"], say: "ada 2 file di docs/ masing2 ada codename", then: ["yg tadi, suruh helper aja satu satu file nya, hasilnya di summary.txt (alpha baris 1, beta baris 2)"] },

  { id: "schedule-1", tool: "schedule", task: "schedule-weekday-digest", styles: ["indonesian", "several-things"], say: "tiap hari kerja jam 9 pagi (WIB) rangkumin komentar NOTE yg masih open di project ini, nama job nya digest. cuma baca ya jgn ngubah apa2" },
  { id: "schedule-2", tool: "schedule", task: "schedule-tomorrow-reminder", styles: ["indonesian", "vague"], say: "ingetin aku besok jam 9 pagi UTC buat siapin catatan standup dari README, job nya namain standup, sekali aja" },
  { id: "schedule-3", tool: "schedule", task: "schedule-first-of-month", styles: ["blend", "no-punctuation"], say: "every 1st of the month 8:30 berlin time list the unpaid invoices mentioned here job name invoices read only pls" },
  { id: "schedule-4", tool: "schedule", task: "schedule-shortest-interval", styles: ["indonesian", "slang"], say: "cek servicenya masih jawab ga tiap 10 detik, nama jobnya pulse. kalo ga boleh sependek itu ya sependek yg boleh aja" },
  { id: "schedule-5", tool: "schedule", task: "schedule-replace-job", styles: ["indonesian", "several-things"], say: "hapus job old-backup, keep-me biarin aja, tambahin 1 job yg jalan sekali 30 menit lagi prompt nya \"check the build\"" },
  { id: "schedule-6", tool: "schedule", task: "schedule-fortnight", styles: ["indonesian", "typos"], say: "tiap 2 minggu hari jumat jam 10 pagi jakarta bikinin laporan status project ini, namanya fortnight, read only ya" },

  { id: "memory-1", tool: "memory", task: "memory-save-convention", styles: ["indonesian", "several-things"], say: "label deploy kita tuh zx-build-N, N nya nomor build. inget ya buat project ini. terus tulis label build 37 di ANSWER.txt satu baris" },
  { id: "memory-2", tool: "memory", task: "memory-typo-forget", styles: ["indonesian", "typos"], say: "staging pindah dr alpha.example.test ke beta.example.test, hapus note lama yg alpha jgn yg lain, trus host staging yg baru tulis di ANSWER.txt" },
  { id: "memory-3", tool: "memory", task: "memory-list-then-replace", styles: ["blend", "vague"], say: "apa aja sih yg kamu inget soal project ini? command tes nya udh ganti jd `bun test --timeout 30000` benerin yg salah, id note yg dibenerin tulis ke ANSWER.txt" },
  { id: "memory-4", tool: "memory", task: "memory-typo-forget", styles: ["english", "caps"], say: "STAGING SERVER MOVED FROM ALPHA.EXAMPLE.TEST TO BETA.EXAMPLE.TEST. FORGET THE OLD NOTE AND KEEP THE OTHERS. NEW HOST GOES IN ANSWER.TXT" },
  { id: "memory-5", tool: "memory", task: "memory-forget-stale", styles: ["indonesian", "follow-up"], say: "staging servernya pindah", then: ["iya yg alpha ke beta, update ingetan kamu soal itu (note lain biarin) trus tulis host barunya ke ANSWER.txt"] },

  { id: "session-search-1", tool: "session-search", task: "newbie-recall", styles: ["indonesian", "vague"], say: "yg kemaren kita omongin soal cutover billing, nomor tiketnya apa ya? tulis di ANSWER.txt" },
  { id: "session-search-2", tool: "session-search", task: "newbie-recall", styles: ["english", "typos"], say: "what was that ticket for the billing cutover i mentioned befor?? put it in ANSWER.txt" },
  { id: "session-search-3", tool: "session-search", task: "newbie-recall", styles: ["indonesian", "slang", "no-punctuation"], say: "tiket yg kmaren itu loh soal pindah billing jam 2 pagian ke ANSWER.txt" },
  { id: "session-search-4", tool: "session-search", task: "newbie-recall", styles: ["blend", "caps"], say: "NOMOR TIKET CUTOVER BILLING YG AKU BILANG KEMARIN APA? TULIS DI ANSWER.TXT" },
  { id: "session-search-5", tool: "session-search", task: "newbie-recall", styles: ["indonesian", "wrong-assumption"], say: "kamu pasti lupa kan tiket cutover billing yg aku kasih tau? cek aja, kalo masih ada tulis ke ANSWER.txt" },
  { id: "session-search-6", tool: "session-search", task: "newbie-recall", styles: ["indonesian", "follow-up"], say: "inget ga kita pernah ngomongin billing?", then: ["yg tadi itu, tiket buat cutover nya apa? tulis di ANSWER.txt"] },

  { id: "skills-1", tool: "skills", task: "skill-multiline-frontmatter", styles: ["indonesian"], say: "ada skill buat siapin label rilis kan di project ini? pake itu buat versi yg di VERSION, hasilnya ke ANSWER.txt satu baris" },
  { id: "skills-2", tool: "skills", task: "skill-multiline-frontmatter", styles: ["english", "typos"], say: "use the release lable skill on whatever version is in VERSION, answer goes in ANSWER.txt on its own line" },
  { id: "skills-3", tool: "skills", task: "skill-multiline-frontmatter", styles: ["indonesian", "vague"], say: "label rilis versi sekarang apa? (VERSION). pake cara yg udah ada di project, ANSWER.txt ya" },
  { id: "skills-4", tool: "skills", task: "skill-multiline-frontmatter", styles: ["caps", "no-punctuation"], say: "PREPARE THE RELEASE LABEL FOR THE VERSION IN VERSION USING THE PROJECT SKILL PUT IT IN ANSWER.TXT ONE LINE" },
  { id: "skills-5", tool: "skills", task: "skill-multiline-frontmatter", styles: ["indonesian", "follow-up"], say: "aku mau bikin label rilis", then: ["pake skill nya yg di project, versi dari file VERSION, taro di ANSWER.txt satu baris"] },

  { id: "vision-1", tool: "vision", task: "read-picture-label", styles: ["indonesian"], say: "chart.png itu gambar yg ada tulisannya, tulisannya apa? tulis di answer.txt" },
  { id: "vision-2", tool: "vision", task: "read-picture-label", styles: ["english", "typos"], say: "whats the lable on chart.png? answer.txt pls" },
  { id: "vision-3", tool: "vision", task: "read-picture-label", styles: ["blend", "vague"], say: "liat gambar chart.png, ada label nya, copy aja tulisannya ke answer.txt" },
  { id: "vision-4", tool: "vision", task: "read-pdf-page", styles: ["indonesian", "caps"], say: "REPORT.PDF ADA 3 HALAMAN, ACCESS CODE DI HALAMAN 3, TULIS KE ANSWER.TXT" },
  { id: "vision-5", tool: "vision", task: "read-pdf-page", styles: ["indonesian", "wrong-assumption"], say: "access code di report.pdf pasti di halaman 1 kan? cek trs tulis di answer.txt" },

  { id: "speech-to-text-1", tool: "speech-to-text", task: "media-transcribe-note", styles: ["indonesian"], say: "meeting.wav itu rekaman rapat, ngomong apa dia? kalimatnya tulis di summary.txt" },
  { id: "speech-to-text-2", tool: "speech-to-text", task: "media-transcribe-note", styles: ["english"], say: "transcribe meeting.wav, put the sentence in summary.txt" },
  { id: "speech-to-text-3", tool: "speech-to-text", task: "media-transcribe-note", styles: ["indonesian", "caps"], say: "MEETING.WAV DENGERIN TRUS TULIS YG DIBILANG KE SUMMARY.TXT" },
  { id: "speech-to-text-4", tool: "speech-to-text", task: "media-transcribe-note", styles: ["english", "typos"], say: "cna u lisen to meeting.wav n write whta the speker says in summary.txt" },
  { id: "speech-to-text-5", tool: "speech-to-text", task: "media-transcribe-note", styles: ["indonesian", "follow-up"], say: "ada rekaman meeting.wav di folder ini", then: ["yg tadi, tulis aja apa yg diomongin ke summary.txt"] },

  { id: "text-to-speech-1", tool: "text-to-speech", task: "media-speak-greeting", styles: ["indonesian"], say: "bacain hello.txt keras2 dong, suaranya simpen jadi greeting.wav" },
  { id: "text-to-speech-2", tool: "text-to-speech", task: "media-speak-greeting", styles: ["english"], say: "read hello.txt out loud and save the audio as greeting.wav" },
  { id: "text-to-speech-3", tool: "text-to-speech", task: "media-speak-greeting", styles: ["slang", "blend"], say: "hello.txt tolong di voice-in jd greeting.wav" },
  { id: "text-to-speech-4", tool: "text-to-speech", task: "media-speak-greeting", styles: ["caps", "no-punctuation"], say: "UBAH ISI HELLO.TXT JADI SUARA SIMPEN GREETING.WAV" },
  { id: "text-to-speech-5", tool: "text-to-speech", task: "media-speak-greeting", styles: ["indonesian", "wrong-assumption"], say: "kamu ga bisa ngomong kan? yaudah coba aja ubah isi hello.txt jadi suara, greeting.wav" },

  { id: "image-1", tool: "image", task: "media-make-banner", styles: ["indonesian"], say: "gambarin mercusuar malem hari dong, yg lebar ya, simpen banner.png" },
  { id: "image-2", tool: "image", task: "media-make-banner", styles: ["english", "slang"], say: "make me a wide pic of a lighthouse at night -> banner.png" },
  { id: "image-3", tool: "image", task: "media-make-banner", styles: ["caps", "no-punctuation"], say: "BIKIN BANNER MERCUSUAR PAS MALAM LEBAR SIMPEN DI BANNER.PNG" },
  { id: "image-4", tool: "image", task: "media-make-banner", styles: ["indonesian", "vague"], say: "bikin banner dong yg bagus, tema mercusuar malem, lebar, banner.png" },
  { id: "image-5", tool: "image", task: "media-make-banner", styles: ["indonesian", "follow-up"], say: "aku butuh gambar mercusuar malam", then: ["lanjut, bikinin yg lebar dan simpen jadi banner.png"] },

  // Video Generation: nothing here makes video, so the right answer is to say so.
  { id: "video-generation-1", tool: "video-generation", task: "newbie-cannot-video", styles: ["indonesian"], say: "bikinin video mercusuar malem 5 detik dong, simpen lighthouse.mp4" },
  { id: "video-generation-2", tool: "video-generation", task: "newbie-cannot-video", styles: ["english"], say: "make a 5 sec video of a lighthouse at night, lighthouse.mp4" },
  { id: "video-generation-3", tool: "video-generation", task: "newbie-cannot-video", styles: ["caps", "indonesian"], say: "BIKIN VIDEO MERCUSUAR MALAM 5 DETIK SIMPEN LIGHTHOUSE.MP4" },
  { id: "video-generation-4", tool: "video-generation", task: "newbie-cannot-video", styles: ["blend", "slang", "typos"], say: "vidio mercusuar animasi gerak2 gitu lighthouse.mp4 ya bro" },
  { id: "video-generation-5", tool: "video-generation", task: "newbie-cannot-video", styles: ["indonesian", "wrong-assumption"], say: "kamu pasti bisa bikin video kan? buat lighthouse.mp4 mercusuar malam 5 detik" },

  // Video Analysis: a real short clip, looked at with the installed picture model.
  { id: "video-analysis-1", tool: "video-analysis", task: "newbie-watch-clip", styles: ["indonesian", "vague"], say: "clip.mp4 itu video pendek, ada tulisan di dalamnya, apa tulisannya? tulis di answer.txt" },
  { id: "video-analysis-2", tool: "video-analysis", task: "newbie-watch-clip", styles: ["english", "typos"], say: "watch clip.mp4 and tell me whats the lable shown in it, put the text in answer.txt" },
  { id: "video-analysis-3", tool: "video-analysis", task: "newbie-watch-clip", styles: ["caps", "no-punctuation"], say: "TONTON CLIP.MP4 ADA LABEL APA DI VIDEO NYA TULIS TEKS NYA DI ANSWER.TXT" },
  { id: "video-analysis-4", tool: "video-analysis", task: "newbie-watch-clip", styles: ["blend", "several-things"], say: "clip.mp4 itu apa isinya? sama label yg muncul bunyinya gimana, tulis ke answer.txt ya" },
  { id: "video-analysis-5", tool: "video-analysis", task: "newbie-watch-clip", styles: ["indonesian", "follow-up"], say: "aku punya video namanya clip.mp4", then: ["lanjut, liat dong labelnya bilang apa, tulis ke answer.txt"] },

  ...bothScreenRows,
];
