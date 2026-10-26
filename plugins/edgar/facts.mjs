// XBRL company facts (data.sec.gov/api/xbrl/companyfacts) reduced to long annual and quarterly histories.

/** Metrics the analyst can ask for; concepts are tried in order, since companies rename them over time. */
export const METRICS = {
  revenue: {
    label: "Revenue",
    unit: "USD",
    concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
  },
  grossProfit: { label: "Gross profit", unit: "USD", concepts: ["GrossProfit"] },
  operatingIncome: { label: "Operating income", unit: "USD", concepts: ["OperatingIncomeLoss"] },
  netIncome: { label: "Net income", unit: "USD", concepts: ["NetIncomeLoss"] },
  epsDiluted: { label: "Diluted EPS", unit: "USD/shares", concepts: ["EarningsPerShareDiluted"] },
  operatingCashFlow: { label: "Operating cash flow", unit: "USD", concepts: ["NetCashProvidedByUsedInOperatingActivities"] },
  capex: { label: "Capital expenditures", unit: "USD", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"] },
  rnd: { label: "R&D expense", unit: "USD", concepts: ["ResearchAndDevelopmentExpense"] },
  cash: { label: "Cash and equivalents", unit: "USD", instant: true, concepts: ["CashAndCashEquivalentsAtCarryingValue"] },
  longTermDebt: { label: "Long-term debt", unit: "USD", instant: true, concepts: ["LongTermDebtNoncurrent", "LongTermDebt"] },
  dilutedShares: { label: "Diluted weighted shares", unit: "shares", concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
};

export const DEFAULT_METRICS = ["revenue", "operatingIncome", "netIncome", "epsDiluted", "operatingCashFlow", "capex"];

const DAY = 86_400_000;
const daysBetween = (start, end) => (Date.parse(end) - Date.parse(start)) / DAY;
const lengthDays = (e) => (e.start ? daysBetween(e.start, e.end) : 0);
const isQuarter = (days) => days >= 80 && days <= 100;
const isYear = (days) => days >= 350 && days <= 380;
const isYearToDate = (days) => isQuarter(days) || (days >= 170 && days <= 190) || (days >= 260 && days <= 285) || isYear(days);
const UNIT_LABEL = { USD: "USD millions", "USD/shares": "USD per share", shares: "millions of shares" };
const SCALE = { USD: 1e6, "USD/shares": 1, shares: 1e6 };

/** One value per period, preferring earlier concepts in the list and then the latest filing (restatements). */
function merge(conceptEntries, keep, keyOf = (e) => e.end) {
  const best = new Map();
  conceptEntries.forEach((entries, rank) => {
    for (const e of entries) {
      if (typeof e.val !== "number" || typeof e.end !== "string" || !keep(e)) continue;
      const key = keyOf(e);
      const prev = best.get(key);
      if (!prev || rank < prev.rank || (rank === prev.rank && String(e.filed) > String(prev.e.filed))) best.set(key, { e, rank });
    }
  });
  return [...best.values()].map((x) => x.e).sort((a, b) => a.end.localeCompare(b.end));
}

/**
 * Quarters that are not filed on their own. Cash flows are reported year to
 * date, so a quarter is the difference of consecutive year-to-date totals from
 * the same start; Q4 is otherwise the annual value minus the three quarters.
 */
function fillQuarters(quarterly, yearToDate, annual) {
  const have = new Map(quarterly.map((q) => [q.end, q]));
  const byStart = new Map();
  for (const e of yearToDate) byStart.set(e.start, [...(byStart.get(e.start) ?? []), e]);
  for (const totals of byStart.values()) {
    totals.sort((a, b) => a.end.localeCompare(b.end));
    for (let i = 1; i < totals.length; i++) {
      const [prev, cur] = [totals[i - 1], totals[i]];
      if (!have.has(cur.end) && isQuarter(daysBetween(prev.end, cur.end))) have.set(cur.end, { start: prev.end, end: cur.end, val: cur.val - prev.val, derived: true });
    }
  }
  for (const y of annual) {
    if (!y.start || have.has(y.end)) continue;
    const inside = [...have.values()].filter((q) => q.start >= y.start && q.end <= y.end);
    if (inside.length === 3) have.set(y.end, { start: inside.at(-1).end, end: y.end, val: y.val - inside.reduce((s, q) => s + q.val, 0), derived: true });
  }
  return [...have.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Compact histories of every metric in METRICS, from a companyfacts document. */
export function extractFacts(raw) {
  const gaap = raw?.facts?.["us-gaap"] ?? {};
  const metrics = {};
  for (const [id, m] of Object.entries(METRICS)) {
    const present = m.concepts.filter((c) => gaap[c]?.units?.[m.unit]?.length);
    if (!present.length) continue;
    const entries = present.map((c) => gaap[c].units[m.unit]);
    const annual = m.instant
      ? merge(entries, (e) => !e.start && e.fp === "FY" && /^10-K/.test(e.form ?? ""))
      : merge(entries, (e) => /^10-K/.test(e.form ?? "") && isYear(lengthDays(e)));
    let quarterly = m.instant ? merge(entries, (e) => !e.start) : merge(entries, (e) => isQuarter(lengthDays(e)));
    // Monetary totals are additive. EPS and weighted-average share counts are
    // not: subtracting their year-to-date or annual averages invents quarters.
    if (!m.instant && m.unit === "USD") {
      const yearToDate = merge(entries, (e) => !!e.start && isYearToDate(lengthDays(e)), (e) => `${e.start}|${e.end}`);
      quarterly = fillQuarters(quarterly, yearToDate, annual);
    }
    const s = SCALE[m.unit];
    const value = (e) => Number((e.val / s).toFixed(s === 1 ? 4 : 1));
    const yearly = annual.slice(-10).map((e, i, all) => ({
      end: e.end,
      value: value(e),
      yoyPct: i > 0 && all[i - 1].val ? Number(((e.val / all[i - 1].val - 1) * 100).toFixed(1)) : null,
    }));
    metrics[id] = {
      label: m.label,
      unit: UNIT_LABEL[m.unit],
      concepts: present,
      annual: yearly,
      quarterly: quarterly.slice(-8).map((e) => ({ end: e.end, value: value(e), ...(e.derived ? { derived: true } : {}) })),
    };
  }
  return { entityName: raw?.entityName ?? null, metrics };
}
