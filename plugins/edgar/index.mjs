// SEC EDGAR plugin for BLMBU Terminal.
//   CF <GO>  Company Filings: every recent SEC filing of a US-listed company, filterable by type.
//   Provider "edgar": company news built from 8-K/10-Q/10-K filings, used when the other providers have none.
//   AI tools for the analyst: list_filings, read_filing, compare_filings, get_company_facts, get_earnings_release.
// Plain ESM with no dependencies or build step. See PLUGINS.md.

import { DEFAULT_METRICS, METRICS, extractFacts } from "./facts.mjs";
import { MOCK_FORMS, mockCompanyFacts, mockDocumentHtml, mockPressReleaseHtml } from "./fixtures.mjs";
import { SECTION_NAMES, diffParagraphs, findSection, htmlToText, page, sectionLabel, splitSections } from "./text.mjs";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const pad = (cik) => String(cik).padStart(10, "0");
const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${pad(cik)}.json`;
const factsUrl = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad(cik)}.json`;
const archiveBase = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, "")}`;
const DAY = 86_400_000;
const SUBMISSIONS_TTL = 10 * 60_000;
const DOCUMENT_TTL = 7 * DAY;
const FACTS_TTL = 12 * 3_600_000;
const MAX_DOCUMENT_CHARS = 2_000_000;

/** Bloomberg exchange codes for US listings. */
const US_CODES = new Set(["US", "UN", "UW", "UQ", "UA", "UP", "UR", "UV", "UF"]);

const FORM_NAMES = {
  "10-K": "Annual report",
  "10-Q": "Quarterly report",
  "8-K": "Current report",
  "20-F": "Annual report (foreign private issuer)",
  "40-F": "Annual report (Canadian issuer)",
  "6-K": "Report of foreign private issuer",
  3: "Initial statement of beneficial ownership",
  4: "Statement of changes in beneficial ownership",
  5: "Annual statement of beneficial ownership",
  144: "Notice of proposed sale of securities",
  "DEF 14A": "Definitive proxy statement",
  "DEFA14A": "Additional proxy soliciting materials",
  "PRE 14A": "Preliminary proxy statement",
  "PX14A6G": "Exempt solicitation notice",
  "SC 13G": "Beneficial ownership report (passive)",
  "SC 13D": "Beneficial ownership report (active)",
  "SCHEDULE 13G": "Beneficial ownership report (passive)",
  "SCHEDULE 13D": "Beneficial ownership report (active)",
  "S-3ASR": "Automatic shelf registration",
  "S-3": "Shelf registration",
  "S-8": "Registration of employee plan securities",
  "S-1": "Registration statement",
  "424B2": "Prospectus",
  "424B5": "Prospectus supplement",
  "FWP": "Free writing prospectus",
  "11-K": "Employee benefit plan annual report",
  "SD": "Specialized disclosure (conflict minerals)",
  "ARS": "Annual report to security holders",
  "CERT": "Exchange certification",
  "25-NSE": "Delisting notice",
  "IRANNOTICE": "Iran activity notice",
  "UPLOAD": "SEC staff letter",
  "CORRESP": "Correspondence with SEC staff",
};

const ITEM_NAMES = {
  "1.01": "Material agreement",
  "1.02": "Termination of material agreement",
  "1.05": "Cybersecurity incident",
  "2.01": "Acquisition or disposition",
  "2.02": "Results of operations",
  "2.03": "Financial obligation",
  "2.05": "Exit or disposal costs",
  "2.06": "Impairment",
  "3.01": "Listing notice",
  "3.02": "Unregistered equity sale",
  "3.03": "Change in security holder rights",
  "4.01": "Change of auditor",
  "5.02": "Officer or director change",
  "5.03": "Charter or bylaw amendment",
  "5.07": "Shareholder vote results",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events",
  "9.01": "Financial statements and exhibits",
};

/** CF option bar: label and form filter. */
const FILTERS = [
  ["All", () => true],
  ["Financials", (f) => /^(10-K|10-Q|20-F|40-F|6-K|ARS|11-K)/.test(f)],
  ["Current Reports", (f) => /^8-K/.test(f)],
  ["Proxies", (f) => /^(DEF|PRE |PRE14|PX14)/.test(f)],
  ["Insiders", (f) => /^(3|4|5|144)(\/A)?$/.test(f)],
  ["Ownership", (f) => /^(SC 13|SCHEDULE 13)/.test(f)],
  ["Registrations", (f) => /^(S-|F-\d|424|FWP)/.test(f)],
];

const NEWS_FORMS = /^(8-K|10-K|10-Q|20-F|40-F|6-K|DEF 14A)/;

/** "BRK/B US Equity" -> "BRK-B" (SEC ticker), or null for non-US listings. */
export function usTicker(security) {
  const parts = String(security ?? "").trim().split(/\s+/);
  if (parts.length < 3 || parts.at(-1).toLowerCase() !== "equity" || !US_CODES.has(parts.at(-2).toUpperCase())) return null;
  return parts.slice(0, -2).join(" ").toUpperCase().replace(/[/.]/g, "-");
}

export function describeFiling(form, docDescription, items) {
  if (/^8-K/.test(form) && items) {
    const names = String(items)
      .split(",")
      .map((s) => ITEM_NAMES[s.trim()])
      .filter(Boolean);
    if (names.length) return names.join("; ");
  }
  const amended = form.endsWith("/A");
  const known = FORM_NAMES[amended ? form.slice(0, -2) : form];
  if (known) return amended ? `${known} (amendment)` : known;
  const d = String(docDescription ?? "").trim();
  return d && d.toUpperCase() !== form.toUpperCase() && !/^FORM\b/i.test(d) ? d : form;
}

/** Rows of the recent-filings table in an EDGAR submissions document, newest first. */
export function filingsOf(sub) {
  const r = sub?.filings?.recent;
  if (!r || !Array.isArray(r.form)) return [];
  return r.form.map((form, i) => {
    const accession = r.accessionNumber[i];
    const base = archiveBase(sub.cik, accession);
    const doc = r.primaryDocument?.[i];
    return {
      filed: r.filingDate[i],
      period: r.reportDate?.[i] || null,
      form,
      accession,
      description: describeFiling(form, r.primaryDocDescription?.[i], r.items?.[i]),
      items: r.items?.[i] || "",
      accepted: r.acceptanceDateTime?.[i] || null,
      url: doc ? `${base}/${doc}` : `${base}/`,
    };
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fiscalYearEnd = (mmdd) => (/^\d{4}$/.test(mmdd ?? "") ? `${MONTHS[Number(mmdd.slice(0, 2)) - 1]} ${Number(mmdd.slice(2))}` : null);

/** Cached `load()` under `key`: the terminal's persistent cache when it provides one, else memory. */
function cacheWith(cache) {
  const memory = new Map();
  return (key, ttlMs, load) => {
    if (cache) return cache.wrap(key, ttlMs, load);
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
    const promise = load();
    memory.set(key, { at: Date.now(), promise });
    promise.catch(() => memory.get(key)?.promise === promise && memory.delete(key));
    if (memory.size > 100) memory.delete(memory.keys().next().value);
    return promise;
  };
}

function secSource(userAgent, cache) {
  let tickers = null;
  const submissions = new Map();
  const cached = cacheWith(cache);
  let nextSlot = 0;

  async function request(url, signal, accept) {
    // The SEC allows at most 10 requests a second.
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + 110;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: accept }, signal });
    if (!res.ok) {
      const hint = res.status === 403 ? " (set SEC_USER_AGENT to your name and email, as the SEC requires)" : "";
      throw new Error(`SEC EDGAR returned HTTP ${res.status}${hint}`);
    }
    return res;
  }
  const get = async (url, signal) => (await request(url, signal, "application/json")).json();

  return {
    /** Plain text of a filing document; filings never change, so it is cached for a week. */
    documentText: (url, signal) =>
      cached(`doc:${url}`, DOCUMENT_TTL, async () => htmlToText(await (await request(url, signal, "text/html, text/plain, */*")).text()).slice(0, MAX_DOCUMENT_CHARS)),
    filingIndex: (cik, accession, signal) => cached(`index:${accession}`, DOCUMENT_TTL, () => get(`${archiveBase(cik, accession)}/index.json`, signal)),
    /** Metric histories from XBRL company facts; the raw document can be tens of megabytes, so only the summary is cached. */
    companyFacts: (cik, signal) => cached(`facts:${cik}`, FACTS_TTL, async () => extractFacts(await get(factsUrl(cik), signal))),
    async lookup(ticker) {
      if (!tickers || Date.now() - tickers.at > DAY) {
        // Shared by concurrent callers, so no caller's abort signal applies to it.
        const promise = get(TICKERS_URL).then(
          (raw) => new Map(Object.values(raw).map((r) => [String(r.ticker).toUpperCase(), { cik: r.cik_str, title: r.title }])),
        );
        tickers = { at: Date.now(), promise };
        promise.catch(() => {
          if (tickers?.promise === promise) tickers = null;
        });
      }
      return (await tickers.promise).get(ticker) ?? null;
    },
    async submissions(cik, signal) {
      const hit = submissions.get(cik);
      if (hit && Date.now() - hit.at < SUBMISSIONS_TTL) return hit.data;
      const data = await get(submissionsUrl(cik), signal);
      submissions.set(cik, { at: Date.now(), data });
      return data;
    },
  };
}

/** Deterministic offline data for PROVIDERS=mock (tests and demos). */
function mockSource(now = () => Date.now()) {
  const items = { "8-K": "2.02,9.01" };
  const cikOf = (ticker) => 1_000_000 + ([...ticker].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 900_000);
  const filedAt = (i) => Math.floor(now() / DAY) * DAY - (i * 9 + 1) * DAY;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const indexOf = (accession) => 900 - Number(String(accession).slice(-6));
  return {
    async documentText(url) {
      const exhibit = /\/ex991-(\d+)\.htm$/.exec(url);
      const doc = /\/doc(\d+)\.htm$/.exec(url);
      if (exhibit) return htmlToText(mockPressReleaseHtml(Number(exhibit[1]), iso(filedAt(Number(exhibit[1])))));
      if (doc) return htmlToText(mockDocumentHtml(Number(doc[1]), iso(filedAt(Number(doc[1])))));
      throw new Error("SEC EDGAR returned HTTP 404");
    },
    async filingIndex(cik, accession) {
      const i = indexOf(accession);
      const names = [`doc${i}.htm`, ...(MOCK_FORMS[i % MOCK_FORMS.length] === "8-K" ? [`ex991-${i}.htm`] : []), "Financial_Report.xlsx"];
      return { directory: { name: archiveBase(cik, accession), item: names.map((name) => ({ name, type: "text.gif", size: "" })) } };
    },
    async companyFacts(cik) {
      return extractFacts(mockCompanyFacts(cik));
    },
    async lookup(ticker) {
      return { cik: cikOf(ticker), title: `${ticker} Holdings Inc.` };
    },
    async submissions(cik) {
      const n = 36;
      const recent = { accessionNumber: [], filingDate: [], reportDate: [], acceptanceDateTime: [], form: [], items: [], primaryDocument: [], primaryDocDescription: [] };
      for (let i = 0; i < n; i++) {
        const form = MOCK_FORMS[i % MOCK_FORMS.length];
        const filed = filedAt(i);
        recent.accessionNumber.push(`0000${cik}-26-${String(900 - i).padStart(6, "0")}`);
        recent.filingDate.push(iso(filed));
        recent.reportDate.push(/^(10-|4|8-K)/.test(form) ? iso(filed - 2 * DAY) : "");
        recent.acceptanceDateTime.push(new Date(filed + 21 * 3_600_000).toISOString());
        recent.form.push(form);
        recent.items.push(items[form] ?? "");
        recent.primaryDocument.push(`doc${i}.htm`);
        recent.primaryDocDescription.push(form);
      }
      return {
        cik: String(cik).padStart(10, "0"),
        name: "Sample Registrant Inc.",
        sic: "3571",
        sicDescription: "Electronic Computers",
        category: "Large accelerated filer",
        stateOfIncorporation: "DE",
        stateOfIncorporationDescription: "DE",
        fiscalYearEnd: "0930",
        exchanges: ["Nasdaq"],
        addresses: { business: { street1: "1 SAMPLE WAY", city: "SPRINGFIELD", stateOrCountryDescription: "CA", zipCode: "90000" } },
        filings: { recent },
      };
    },
  };
}

function notCovered(text) {
  return { blocks: [{ type: "text", text }] };
}

async function companyFilings(source, security, option, signal) {
  const ticker = usTicker(security);
  if (!ticker) return notCovered(`SEC EDGAR covers companies listed in the US. ${security} is not a US listing.`);
  const match = await source.lookup(ticker);
  if (!match) return notCovered(`${ticker} is not in the SEC's list of registrant tickers.`);
  const sub = await source.submissions(match.cik, signal);
  const [label, keep] = FILTERS[option] ?? FILTERS[0];
  const filings = filingsOf(sub).filter((f) => keep(f.form));
  const address = sub.addresses?.business;
  return {
    title: sub.name,
    blocks: [
      {
        type: "kv",
        items: [
          ["Company", sub.name],
          ["CIK", String(Number(sub.cik))],
          ["Industry (SIC)", sub.sicDescription ? `${sub.sic} ${sub.sicDescription}` : null],
          ["Filer Category", sub.category || null],
          ["Incorporated", sub.stateOfIncorporationDescription || sub.stateOfIncorporation || null],
          ["Fiscal Year End", fiscalYearEnd(sub.fiscalYearEnd)],
          ["Exchanges", [...new Set((sub.exchanges ?? []).filter(Boolean))].join(", ") || null],
          ["Address", address ? [address.street1, address.city, address.stateOrCountryDescription, address.zipCode].filter(Boolean).join(", ") : null],
        ],
      },
      {
        type: "table",
        title: `${label === "All" ? "Recent" : label} Filings (${filings.length})`,
        columns: [
          { key: "filed", label: "Filed", format: "date" },
          { key: "form", label: "Form" },
          { key: "description", label: "Description" },
          { key: "period", label: "Period", format: "date" },
        ],
        rows: filings,
        linkKey: "url",
      },
      { type: "text", text: "Source: SEC EDGAR (data.sec.gov). Click a filing to open it on sec.gov." },
    ],
  };
}

// ---------------------------------------------------------------- AI analyst tools

/** "AAPL US Equity", or a bare ticker such as "AAPL" or "BRK.B", as an SEC ticker; null for non-US listings. */
export function tickerOf(input) {
  const s = String(input ?? "").trim();
  return /^[A-Za-z][A-Za-z0-9./-]{0,9}$/.test(s) ? s.toUpperCase().replace(/[/.]/g, "-") : usTicker(s);
}

async function registrant(source, security) {
  const ticker = tickerOf(security);
  if (!ticker) throw new Error(`SEC EDGAR covers US-listed companies; "${security}" is not a US listing`);
  const match = await source.lookup(ticker);
  if (!match) throw new Error(`${ticker} is not in the SEC's list of registrant tickers`);
  return match;
}

async function companyOf(source, security, signal) {
  const { cik } = await registrant(source, security);
  const sub = await source.submissions(cik, signal);
  return { cik, name: sub.name, filings: filingsOf(sub) };
}

const brief = (f) => ({ form: f.form, filed: f.filed, period: f.period, description: f.description, accession: f.accession, url: f.url });
const filingSource = (name, f, what = f.form) => ({ label: `SEC EDGAR: ${name} ${what} filed ${f.filed}`, url: f.url, asOf: f.filed });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function pickFiling(filings, form, accession) {
  if (accession) return filings.find((f) => f.accession === accession) ?? null;
  return filings.find((f) => f.form === form) ?? filings.find((f) => f.form === `${form}/A`) ?? null;
}

/** Drop items from the longest of `lists` until the result's JSON fits `budget` characters. */
function fit(result, lists, budget) {
  while (JSON.stringify(result).length > budget) {
    const key = lists.filter((k) => result[k].length).sort((a, b) => result[b].length - result[a].length)[0];
    if (!key) break;
    result[key].pop();
    result.omitted = (result.omitted ?? 0) + 1;
  }
  return result;
}

async function listFilings(source, args, { signal }) {
  const c = await companyOf(source, args.security, signal);
  const raw = Array.isArray(args.forms) ? args.forms : typeof args.forms === "string" ? args.forms.split(",") : [];
  const forms = raw.map((f) => String(f).trim().toUpperCase()).filter(Boolean);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit)) || 15, 1), 40);
  const rows = c.filings.filter((f) => !forms.length || forms.some((w) => f.form === w || f.form.startsWith(`${w}/`))).slice(0, limit);
  return {
    summary: `Listed ${rows.length} ${forms.length ? `${forms.join("/")} ` : ""}filings of ${c.name}`,
    result: { company: c.name, cik: c.cik, filings: rows.map((f) => ({ ...brief(f), ...(f.items ? { items: f.items } : {}) })) },
    sources: [{ label: `SEC EDGAR: filings of ${c.name}`, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}`, ...(rows[0] ? { asOf: rows[0].filed } : {}) }],
  };
}

async function readFiling(source, args, { signal, maxResultChars }) {
  const c = await companyOf(source, args.security, signal);
  const form = String(args.form || "10-K").trim().toUpperCase();
  const f = pickFiling(c.filings, form, args.accession ? String(args.accession).trim() : null);
  if (!f) throw new Error(`${c.name} has no recent ${args.accession ? `filing ${args.accession}` : form} on EDGAR`);
  const text = await source.documentText(f.url, signal);
  const sections = splitSections(text);
  const found = [...sections.values()].filter((s) => s.text.length > 120).map((s) => ({ key: s.key, title: clip(s.title, 60), chars: s.text.length }));
  let body = text;
  let section = null;
  if (args.section) {
    const s = findSection(sections, f.form, args.section);
    if (!s) throw new Error(`No section "${args.section}" in this ${f.form}. Found: ${found.map((x) => `${x.key} ${x.title}`).join("; ") || "no Item headings"}`);
    body = s.text;
    section = { key: s.key, title: s.title, label: sectionLabel(s, f.form) };
  }
  const chunk = page(body, args.offset, Math.max(2_000, maxResultChars - 1_500 - JSON.stringify(found).length));
  return {
    summary: `Read ${section ? `${section.label} of ` : ""}${c.name}'s ${f.form} filed ${f.filed}${chunk.offset ? ` from character ${chunk.offset}` : ""}`,
    result: { company: c.name, filing: brief(f), section, sections: found, ...chunk },
    sources: [filingSource(c.name, f, section ? `${f.form} ${section.label}` : f.form)],
  };
}

async function compareFilings(source, args, { signal, maxResultChars }) {
  const c = await companyOf(source, args.security, signal);
  const form = String(args.form || "10-K").trim().toUpperCase();
  const wanted = args.section || (form === "10-Q" ? "mda" : "risk factors");
  const [newer, older] = c.filings.filter((f) => f.form === form);
  if (!older) throw new Error(`Comparing needs two recent ${form} filings of ${c.name} on EDGAR; found ${newer ? "one" : "none"}`);
  const [newText, oldText] = await Promise.all([source.documentText(newer.url, signal), source.documentText(older.url, signal)]);
  const after = findSection(splitSections(newText), form, wanted);
  const before = findSection(splitSections(oldText), form, wanted);
  if (!after || !before) throw new Error(`Could not find "${wanted}" in both ${form} filings`);
  const d = diffParagraphs(before.text, after.text);
  const result = fit(
    {
      company: c.name,
      form,
      section: { key: after.key, title: after.title || before.title },
      newer: brief(newer),
      older: brief(older),
      counts: { added: d.added.length, removed: d.removed.length, reworded: d.changed.length, unchanged: d.unchanged },
      added: d.added.map((p) => clip(p, 600)),
      removed: d.removed.map((p) => clip(p, 600)),
      reworded: d.changed.map((x) => ({ before: clip(x.before, 400), after: clip(x.after, 400), newTerms: x.newTerms, droppedTerms: x.droppedTerms })),
    },
    ["added", "removed", "reworded"],
    maxResultChars - 200,
  );
  return {
    summary: `Compared ${sectionLabel(after, form)} of ${c.name}'s ${form}s filed ${newer.filed} and ${older.filed}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} reworded`,
    result,
    sources: [filingSource(c.name, newer), filingSource(c.name, older)],
  };
}

async function companyFacts(source, args, { signal, maxResultChars }) {
  const { cik, title } = await registrant(source, args.security);
  const wanted = (Array.isArray(args.metrics) && args.metrics.length ? args.metrics : DEFAULT_METRICS).map(String);
  const unknown = wanted.filter((m) => !METRICS[m]);
  if (unknown.length) throw new Error(`Unknown metrics ${unknown.join(", ")}. Available: ${Object.keys(METRICS).join(", ")}`);
  const facts = await source.companyFacts(cik, signal);
  const metrics = Object.fromEntries(wanted.filter((m) => facts.metrics[m]).map((m) => [m, structuredClone(facts.metrics[m])]));
  const missing = wanted.filter((m) => !facts.metrics[m]);
  const name = facts.entityName ?? title;
  const result = {
    company: name,
    metrics,
    ...(missing.length ? { notReported: missing } : {}),
    note: "XBRL data from 10-K and 10-Q filings. Restated periods use the latest filing; derived quarters are the annual value minus the other three.",
  };
  for (const keep of [6, 4, 2, 0]) {
    if (JSON.stringify(result).length <= maxResultChars - 200) break;
    for (const m of Object.values(metrics)) m.quarterly = m.quarterly.slice(-keep);
  }
  for (const keep of [7, 5, 3]) {
    if (JSON.stringify(result).length <= maxResultChars - 200) break;
    for (const m of Object.values(metrics)) m.annual = m.annual.slice(-keep);
  }
  const latest = Object.values(metrics).flatMap((m) => [...m.annual, ...m.quarterly].map((p) => p.end)).sort().at(-1);
  return {
    summary: `Loaded XBRL ${wanted.join(", ")} for ${name}`,
    result,
    sources: [{ label: `SEC XBRL company facts: ${name}`, url: factsUrl(cik), ...(latest ? { asOf: latest } : {}) }],
  };
}

async function earningsRelease(source, args, { signal, maxResultChars }) {
  const c = await companyOf(source, args.security, signal);
  const f = args.accession
    ? c.filings.find((x) => x.accession === String(args.accession).trim())
    : c.filings.find((x) => /^8-K/.test(x.form) && /(^|,)\s*2\.02\b/.test(x.items));
  if (!f) throw new Error(`${c.name} has no recent 8-K reporting results (Item 2.02) on EDGAR`);
  const primary = f.url.split("/").pop();
  const index = await source.filingIndex(c.cik, f.accession, signal);
  const names = (index?.directory?.item ?? []).map((x) => String(x.name)).filter((n) => /\.(htm|html|txt)$/i.test(n) && n !== primary);
  const exhibit = names.find((n) => /ex-?99[._-]?0?1(?!\d)|ex991|exhibit-?99\.?1/i.test(n)) ?? null;
  const url = exhibit ? `${archiveBase(c.cik, f.accession)}/${exhibit}` : f.url;
  const chunk = page(await source.documentText(url, signal), args.offset, Math.max(2_000, maxResultChars - 1_200));
  return {
    summary: `Read ${c.name}'s earnings release (8-K filed ${f.filed})`,
    result: { company: c.name, filing: { ...brief(f), items: f.items }, document: exhibit ? "Exhibit 99.1 press release" : "8-K text (no Exhibit 99.1 found)", url, ...chunk },
    sources: [{ label: `SEC EDGAR: ${c.name} earnings release, 8-K filed ${f.filed}`, url, asOf: f.filed }],
  };
}

const SECURITY = { type: "string", description: 'US-listed company, e.g. "AAPL US Equity"' };
const OFFSET = { type: "number", description: "Character offset to continue reading from (nextOffset of the previous call)" };

/** @returns {import("../../server/src/plugins/sdk.ts").PluginAiTool[]} */
function analystTools(source) {
  const tool = (spec, run) => ({ spec, run: (args, ctx) => run(source, args ?? {}, ctx) });
  return [
    tool(
      {
        name: "list_filings",
        description: "Recent SEC filings of a US-listed company, newest first, optionally only some forms (10-K, 10-Q, 8-K, 4, DEF 14A...). Returns filing dates, forms, descriptions, 8-K item numbers, accession numbers and links.",
        parameters: { type: "object", properties: { security: SECURITY, forms: { type: "array", items: { type: "string" } }, limit: { type: "number" } }, required: ["security"] },
      },
      listFilings,
    ),
    tool(
      {
        name: "read_filing",
        description: `Read the text of a company's latest filing of a form (default 10-K), or one filing by accession, optionally one Item section: an item number ("1A", "7", "2.02") or a name. Names for 10-K: ${SECTION_NAMES["10-K"].join(", ")}; for 10-Q: ${SECTION_NAMES["10-Q"].join(", ")}. Long text comes in pages; pass nextOffset as offset to continue. The result lists the sections found.`,
        parameters: {
          type: "object",
          properties: { security: SECURITY, form: { type: "string" }, accession: { type: "string" }, section: { type: "string" }, offset: OFFSET },
          required: ["security"],
        },
      },
      readFiling,
    ),
    tool(
      {
        name: "compare_filings",
        description: "What changed in one section between a company's two most recent filings of a form (default: risk factors in the 10-K; for a 10-Q the default is MD&A): paragraphs added, removed and reworded, with the new and dropped terms of reworded ones. Use for questions like \"what new risks did they disclose?\"",
        parameters: { type: "object", properties: { security: SECURITY, form: { type: "string", enum: ["10-K", "10-Q", "20-F"] }, section: { type: "string" } }, required: ["security"] },
      },
      compareFilings,
    ),
    tool(
      {
        name: "get_company_facts",
        description: `Up to 10 years of annual and 8 quarters of reported financials from SEC XBRL data (longer than get_financials), with year-over-year growth. Metrics: ${Object.keys(METRICS).join(", ")} (default: ${DEFAULT_METRICS.join(", ")}).`,
        parameters: { type: "object", properties: { security: SECURITY, metrics: { type: "array", items: { type: "string", enum: Object.keys(METRICS) } } }, required: ["security"] },
      },
      companyFacts,
    ),
    tool(
      {
        name: "get_earnings_release",
        description: "Text of a company's latest earnings press release (Exhibit 99.1 of the most recent 8-K with Item 2.02), or of one 8-K by accession. Compare it with get_estimates to judge beats, misses and guidance changes.",
        parameters: { type: "object", properties: { security: SECURITY, accession: { type: "string" }, offset: OFFSET }, required: ["security"] },
      },
      earningsRelease,
    ),
  ];
}

/** @param {import("../../server/src/plugins/sdk.ts").PluginContext} ctx */
export default function edgarPlugin(ctx) {
  const userAgent = ctx.env.SEC_USER_AGENT || "BLMBU Terminal (open-source; set SEC_USER_AGENT) admin@example.com";
  const source = ctx.mock ? mockSource() : secSource(userAgent, ctx.cache);

  /** @type {import("../../server/src/plugins/sdk.ts").TerminalPlugin} */
  const plugin = {
    name: "edgar",
    version: "1.1.0",
    providers: [
      {
        id: "edgar",
        sectors: ["Equity"],
        async companyNews(security) {
          const ticker = usTicker(security);
          const match = ticker ? await source.lookup(ticker) : null;
          if (!match) return [];
          const sub = await source.submissions(match.cik);
          return filingsOf(sub)
            .filter((f) => NEWS_FORMS.test(f.form))
            .slice(0, 25)
            .map((f) => ({
              id: `edgar-${f.accession}`,
              title: `${sub.name} files ${f.form}: ${f.description}`,
              source: "SEC EDGAR",
              time: f.accepted ?? `${f.filed}T00:00:00Z`,
              url: f.url,
            }));
        },
      },
    ],
    functions: [
      {
        code: "CF",
        name: "Company Filings",
        security: true,
        sectors: ["Equity"],
        options: FILTERS.map(([label]) => label),
        run: ({ security, option, signal }) => companyFilings(source, security, option, signal),
      },
    ],
    aiTools: analystTools(source),
  };
  return plugin;
}
