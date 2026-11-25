/**
 * The data of the second measurement (mc2-* tasks): forty accounts with their invoices and tickets, served by the MCP fixture server,
 * and twelve status pages, served by the fixture web. Everything is made from the run's secret, so no answer can be guessed, and the
 * check works the expected answer out again from this same generator: it is never stored.
 */
import { createHash } from "node:crypto";

export const ACCOUNTS = 40;
export const PER_PAGE = 10;
export const PAGES = 12;
/** The task that asks for the accounts over this balance (in cents). */
export const THRESHOLD_CENTS = 250_000;
export const KEYWORD = "chargeback";

const sha = (text: string): string => createHash("sha1").update(text).digest("hex");

/** A small seeded generator: the same secret and label always give the same numbers. */
export function rng(secret: string, label: string) {
  let a = parseInt(sha(`${secret}mc2${label}`).slice(0, 8), 16) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]): T => list[int(0, list.length - 1)]!;
  const shuffle = <T>(list: readonly T[]): T[] => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = int(0, i); [out[i], out[j]] = [out[j]!, out[i]!]; } return out; };
  return { next, int, pick, shuffle, chance: (p: number): boolean => next() < p };
}

const PREFIX = ["Northwind", "Harbor", "Quill", "Kestrel", "Juniper", "Marlow", "Cobalt", "Alder", "Birch", "Tidewater", "Granite", "Lumen", "Saffron", "Ironwood", "Copperleaf", "Meridian"];
const SUFFIX = ["Labs", "Foods", "Freight", "Works", "Group", "Systems", "Textiles", "Studios", "Logistics", "Dental", "Optics", "Analytics"];
const FIRST = ["Ava", "Noor", "Luca", "Mei", "Tomas", "Imani", "Piotr", "Sofia", "Kenji", "Amara", "Diego", "Freya"];
const LAST = ["Okafor", "Lindqvist", "Moreau", "Tanaka", "Haddad", "Novak", "Reyes", "Brandt", "Castellan", "Vasquez", "Osei", "Kowalski"];
const STREET = ["Mill Lane", "Harbour Road", "Station Street", "Orchard Way", "Foundry Row", "Canal Walk", "Beacon Hill", "Quarry Close"];
const CITY = ["Leeds", "Porto", "Gdansk", "Utrecht", "Tampere", "Graz", "Cork", "Bilbao"];
const REGIONS = ["eu-west", "eu-north", "us-east", "us-west", "ap-south", "ap-east"];
const PLANS = ["starter", "team", "business", "enterprise"];
const TAGS = ["annual", "invoiced-by-po", "reseller", "education", "nonprofit", "migrated-2024", "priority-support", "custom-sla", "sandbox", "usage-based"];
const EVENT = ["payment received", "invoice issued", "plan changed", "seat count updated", "credit applied", "support escalation closed", "contact changed", "renewal quoted", "usage report sent", "limit raised"];
const MEMO = ["Confirmed by the account owner by email and noted in the billing system", "Applied after the monthly review with the finance contact", "Handled by the regional team; no further action was needed", "Follows the agreement signed at renewal; see the contract folder", "Entered by the billing robot from the bank file of the day"];

export interface Account {
  id: string; name: string; status: string; plan: string; region: string; created: string;
  owner: { name: string; email: string; phone: string; address: { line1: string; city: string; postcode: string; country: string } };
  billing: { currency: string; terms_days: number; balance_due_cents: number; credit_limit_cents: number; last_payment_cents: number; last_payment_on: string; autopay: boolean };
  flags: { audit_hold: boolean; vip: boolean; beta: boolean };
  contacts: { name: string; email: string; role: string }[];
  tags: string[];
  notes: string;
  history: { on: string; type: string; amount_cents: number; memo: string }[];
}
export interface Invoice { number: string; issued: string; due: string; status: "paid" | "open" | "overdue" | "void" | "draft"; total_cents: number; lines: { description: string; quantity: number; unit_cents: number }[] }
export interface Ticket { id: string; account_id: string; subject: string; status: "open" | "closed" | "pending"; priority: string; opened: string; body: string }
export interface StatusPage { n: number; ttl: number; account: string; previous: string }

export interface World {
  /** The accounts in the order the list gives them. */
  order: string[];
  accounts: Record<string, Account>;
  invoices: Record<string, Invoice[]>;
  tickets: Ticket[];
  /** The one account with the audit hold, and where it stands in the list (counted from 0). */
  holdId: string;
  holdAt: number;
  pages: StatusPage[];
  /** The page whose cache TTL differs, and the TTL the others have. */
  oddPage: number;
  commonTtl: number;
}

const date = (r: ReturnType<typeof rng>, year: number): string => `${year}-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`;

function makeAccount(secret: string, id: string, high: boolean, hold: boolean, special?: number): Account {
  const r = rng(secret, `account${id}`);
  const first = r.pick(FIRST), last = r.pick(LAST), company = `${r.pick(PREFIX)} ${r.pick(SUFFIX)}`;
  const slug = company.toLowerCase().replace(/\W+/g, "");
  const balance = special ?? (high ? r.int(THRESHOLD_CENTS + 1, 480_000) : r.int(0, THRESHOLD_CENTS - 1));
  return {
    id, name: company, status: r.pick(["active", "active", "active", "past_due", "trial"]), plan: r.pick(PLANS), region: r.pick(REGIONS), created: date(r, 2023),
    owner: { name: `${first} ${last}`, email: `${first}.${last}@${slug}.example`.toLowerCase(), phone: `+${r.int(30, 49)} ${r.int(100, 999)} ${r.int(1000, 9999)} ${r.int(100, 999)}`, address: { line1: `${r.int(1, 240)} ${r.pick(STREET)}`, city: r.pick(CITY), postcode: `${r.int(1000, 9999)} ${String.fromCharCode(65 + r.int(0, 25))}${String.fromCharCode(65 + r.int(0, 25))}`, country: r.pick(["IE", "PT", "PL", "NL", "FI", "AT", "ES", "GB"]) } },
    billing: { currency: "USD", terms_days: r.pick([14, 30, 45, 60]), balance_due_cents: balance, credit_limit_cents: r.int(100, 900) * 1000, last_payment_cents: r.int(5, 400) * 1000, last_payment_on: date(r, 2026), autopay: r.chance(0.5) },
    flags: { audit_hold: hold, vip: r.chance(0.15), beta: r.chance(0.3) },
    contacts: Array.from({ length: 3 }, () => { const f = r.pick(FIRST), l = r.pick(LAST); return { name: `${f} ${l}`, email: `${f}.${l}@${slug}.example`.toLowerCase(), role: r.pick(["billing", "technical", "legal", "procurement", "security"]) }; }),
    tags: r.shuffle(TAGS).slice(0, r.int(2, 4)),
    notes: `${r.pick(["Prefers email over phone.", "Asked to be invoiced in the first week of the month.", "Two sites share one contract.", "Renewal talks are led by the founder."])} ${r.pick(["Ask before changing seat counts.", "No known issues.", "The audit review of last year found nothing open.", "A credit note is pending approval."])} ${r.pick(MEMO)}.`,
    history: Array.from({ length: r.int(9, 12) }, () => ({ on: date(r, r.pick([2025, 2026])), type: r.pick(EVENT), amount_cents: r.int(0, 600) * 100, memo: r.pick(MEMO) })),
  };
}

function makeInvoices(secret: string, id: string): Invoice[] {
  const r = rng(secret, `invoices${id}`);
  const n = r.int(3, 4);
  return Array.from({ length: n }, (_, i) => {
    const lines = Array.from({ length: r.int(2, 3) }, () => ({ description: r.pick(["Platform subscription", "Extra seats", "Storage overage", "Premium support", "Onboarding session", "Data export"]), quantity: r.int(1, 40), unit_cents: r.int(2, 90) * 100 }));
    return { number: `INV-${id.slice(3)}-${i + 1}`, issued: date(r, 2026), due: date(r, 2026), status: r.pick(["paid", "paid", "open", "overdue", "void", "draft"] as const), total_cents: lines.reduce((s, l) => s + l.quantity * l.unit_cents, 0), lines };
  });
}

const SUBJECT = ["Cannot log in after the password reset", "Question about the seat count on the last invoice", "Export to CSV is slow", "Please update the billing contact", "Webhook retries arrive twice", "Need a copy of the signed agreement", "Invoice PDF shows the wrong address", "Dashboard charts do not load"];
const BODY = ["The person who wrote in says it started this week and asks for a reply by email.", "Support asked for a screenshot and the exact time it happened; none has arrived yet.", "The customer is on a deadline and would like an answer before the end of the month.", "Forwarded to the regional team, who will look at it after the next release."];
const DISPUTE = [`A ${KEYWORD} was opened by the bank for one of the card payments last month.`, `The customer reports a ${KEYWORD} on the March invoice and asks us to stop collection.`, `Their bank started a ${KEYWORD}; they ask whether the evidence has been sent.`];
const DISPUTE_SUBJECT = [`${KEYWORD[0]!.toUpperCase()}${KEYWORD.slice(1)} on a card payment`, `Bank ${KEYWORD} notice`, `Re: ${KEYWORD} evidence`];

const cache = new Map<string, World>();

export function world(secret: string): World {
  const hit = cache.get(secret);
  if (hit) return hit;
  const r = rng(secret, "world");
  const used = new Set<string>();
  const ids: string[] = [];
  while (ids.length < ACCOUNTS) { const id = `AC-${r.int(1000, 9999)}`; if (!used.has(id)) { used.add(id); ids.push(id); } }
  const order = r.shuffle(ids);
  const holdAt = r.int(24, 33);
  const highCount = r.int(7, 10);
  const high = new Set(r.shuffle(ids).slice(0, highCount));
  // Two accounts stand on the border: one is exactly at the threshold and one a cent under it. Neither is over.
  const border = r.shuffle(ids.filter((id) => !high.has(id))).slice(0, 2);
  const accounts: Record<string, Account> = {};
  for (const id of ids) accounts[id] = makeAccount(secret, id, high.has(id), id === order[holdAt], id === border[0] ? THRESHOLD_CENTS : id === border[1] ? THRESHOLD_CENTS - 1 : undefined);
  const invoices = Object.fromEntries(ids.map((id) => [id, makeInvoices(secret, id)]));

  const t = rng(secret, "tickets");
  let ticketNo = 3000;
  const tickets: Ticket[] = [];
  const make = (account_id: string, subject: string, body: string, status: Ticket["status"]): void => { tickets.push({ id: `T-${++ticketNo}`, account_id, subject, status, priority: t.pick(["low", "normal", "high"]), opened: date(t, 2026), body }); };
  // The first account of the list has exactly two tickets, so the small task has a known answer.
  for (const id of order) for (let k = 0; k < (id === order[0] ? 2 : t.int(0, 2)); k++) make(id, t.pick(SUBJECT), t.pick(BODY), t.pick(["open", "closed", "closed", "pending"]));
  const disputed = t.shuffle(ids.filter((id) => id !== order[0]));
  disputed.slice(0, 12).forEach((id) => make(id, t.pick(DISPUTE_SUBJECT), t.pick(DISPUTE), "open"));
  disputed.slice(12, 17).forEach((id) => make(id, t.pick(DISPUTE_SUBJECT), t.pick(DISPUTE), "closed"));
  disputed.slice(17, 20).forEach((id) => make(id, t.pick(DISPUTE_SUBJECT), t.pick(DISPUTE), "pending"));
  const shuffled = t.shuffle(tickets);
  const numbered = shuffled.map((x, i) => ({ ...x, id: `T-${3001 + i}` }));

  const p = rng(secret, "pages");
  const oddPage = p.int(2, 11);
  const commonTtl = p.pick([300, 600, 900]);
  const owners = p.shuffle(ids).slice(0, PAGES);
  const pages = Array.from({ length: PAGES }, (_, i) => ({ n: i + 1, ttl: i + 1 === oddPage ? p.pick([30, 60, 120, 1800]) : commonTtl, account: owners[i]!, previous: `AC-${p.int(1000, 9999)}` }));
  const w: World = { order, accounts, invoices, tickets: numbered, holdId: order[holdAt]!, holdAt, pages, oddPage, commonTtl };
  cache.set(secret, w);
  return w;
}

export const unpaid = (w: World, id: string): number => w.invoices[id]!.filter((i) => i.status === "open" || i.status === "overdue").reduce((s, i) => s + i.total_cents, 0);

/** What each of the tools answers, as the text the server sends. */
export const answerFor = {
  list_accounts(w: World, page: number): string {
    const start = (page - 1) * PER_PAGE;
    const slice = w.order.slice(start, start + PER_PAGE);
    return JSON.stringify({ page, accounts: slice, next_page: start + PER_PAGE < w.order.length ? page + 1 : null });
  },
  get_account: (w: World, id: string): string | undefined => (w.accounts[id] ? JSON.stringify(w.accounts[id], null, 2) : undefined),
  get_invoices: (w: World, id: string): string | undefined => (w.invoices[id] ? JSON.stringify({ account_id: id, currency: "USD", invoices: w.invoices[id] }, null, 2) : undefined),
  search_tickets(w: World, query: string): string {
    const q = query.toLowerCase();
    const hits = w.tickets.filter((x) => `${x.account_id} ${x.subject} ${x.body}`.toLowerCase().includes(q));
    return JSON.stringify({ query, count: hits.length, tickets: hits }, null, 2);
  },
};

const FILLER = ["The scheduler wakes each worker on a timer and checks its queue before it goes back to sleep.", "Configuration is read once at start and again whenever the operator sends the reload signal.", "A node that falls behind its peers reports the delay here and keeps serving what it has.", "Capacity figures are measured over the last hour and are rounded to the nearest whole unit.", "Maintenance windows are announced in the operator channel at least a day before they begin.", "Logs are kept for thirty days on the node and shipped to the archive every night.", "Health checks run every ten seconds and a node is taken out of rotation after three misses."];

/** The text of status page `n`: about seven kilobytes, with the settings list, the billing account and a former one that is closed. */
export function statusPage(secret: string, n: number): { title: string; html: string } {
  const w = world(secret);
  const page = w.pages[n - 1]!;
  const r = rng(secret, `page${n}`);
  const settings: [string, string | number][] = [
    ["listen_port", 8000 + r.int(0, 99)], ["max_connections", r.int(2, 20) * 100], ["worker_threads", r.int(4, 32)],
    ["session_ttl_seconds", r.pick([900, 1200, 3600])], ["cache_ttl_seconds", page.ttl], ["cache_ttl_stale_seconds", r.pick([30, 60, 120, 300])],
    ["retry_limit", r.int(2, 6)], ["log_level", r.pick(["info", "warn", "debug"])], ["tls_min_version", r.pick(["1.2", "1.3"])], ["queue_depth", r.int(1, 40) * 50],
  ];
  const paragraphs: string[] = [];
  let size = 0;
  while (size < 5900) { const text = Array.from({ length: 4 }, () => r.pick(FILLER)).join(" "); paragraphs.push(`<p>${text}</p>`); size += text.length; }
  const html = `<p>Node ${n} of ${PAGES}.</p><h2>Settings</h2><ul>${settings.map(([k, v]) => `<li>${k}: ${v}</li>`).join("")}</ul><h2>Account</h2><p>Billing account: ${page.account}</p><p>Previous billing account (closed, kept for the record): ${page.previous}</p><h2>Notes</h2>${paragraphs.join("\n")}`;
  return { title: `Status of node ${n}`, html };
}

/** What each task must have written, worked out from the generator. */
export const expected = {
  over(secret: string): string[] { const w = world(secret); return Object.values(w.accounts).filter((a) => a.billing.balance_due_cents > THRESHOLD_CENTS).map((a) => a.id).sort(); },
  hold(secret: string): { account: string; unpaid_cents: number } { const w = world(secret); return { account: w.holdId, unpaid_cents: unpaid(w, w.holdId) }; },
  chargebacks(secret: string): string[][] {
    const w = world(secret);
    return w.tickets.filter((x) => x.status === "open" && `${x.subject} ${x.body}`.toLowerCase().includes(KEYWORD)).sort((a, b) => a.id.localeCompare(b.id)).map((x) => [x.id, x.account_id, w.accounts[x.account_id]!.region, String(unpaid(w, x.account_id))]);
  },
  odd(secret: string): { page: number; ttl: number } { const w = world(secret); return { page: w.oddPage, ttl: w.pages[w.oddPage - 1]!.ttl }; },
  plans(secret: string): string[][] { const w = world(secret); return w.pages.map((p) => [String(p.n), p.account, w.accounts[p.account]!.plan]); },
  first(secret: string): string[] { const w = world(secret); return w.tickets.filter((x) => x.account_id === w.order[0]).map((x) => x.id).sort(); },
};
