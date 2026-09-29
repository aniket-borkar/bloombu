import type { FinancialStatement, Statement, StatementPeriod } from "../types.js";

/** Curated statement lines: provider field key and display label, in display order. */
export const STATEMENT_ROWS: Record<Statement, [key: string, label: string][]> = {
  income: [
    ["totalRevenue", "Revenue"],
    ["costOfRevenue", "Cost of Revenue"],
    ["grossProfit", "Gross Profit"],
    ["researchAndDevelopment", "Research & Development"],
    ["sellingGeneralAndAdministration", "SG&A"],
    ["operatingExpense", "Operating Expenses"],
    ["operatingIncome", "Operating Income"],
    ["EBITDA", "EBITDA"],
    ["interestExpense", "Interest Expense"],
    ["pretaxIncome", "Pretax Income"],
    ["taxProvision", "Income Tax"],
    ["netIncome", "Net Income"],
    ["basicEPS", "EPS (Basic)"],
    ["dilutedEPS", "EPS (Diluted)"],
    ["dilutedAverageShares", "Diluted Shares"],
  ],
  balance: [
    ["cashAndCashEquivalents", "Cash & Equivalents"],
    ["cashCashEquivalentsAndShortTermInvestments", "Cash & ST Investments"],
    ["receivables", "Receivables"],
    ["inventory", "Inventory"],
    ["currentAssets", "Total Current Assets"],
    ["netPPE", "Net PP&E"],
    ["totalAssets", "Total Assets"],
    ["payables", "Payables"],
    ["currentDebt", "Current Debt"],
    ["currentLiabilities", "Total Current Liabilities"],
    ["longTermDebt", "Long-Term Debt"],
    ["totalDebt", "Total Debt"],
    ["netDebt", "Net Debt"],
    ["totalLiabilitiesNetMinorityInterest", "Total Liabilities"],
    ["stockholdersEquity", "Shareholders' Equity"],
    ["retainedEarnings", "Retained Earnings"],
    ["workingCapital", "Working Capital"],
    ["ordinarySharesNumber", "Shares Outstanding"],
  ],
  cashflow: [
    ["operatingCashFlow", "Operating Cash Flow"],
    ["depreciationAndAmortization", "Depreciation & Amortization"],
    ["stockBasedCompensation", "Stock-Based Compensation"],
    ["changeInWorkingCapital", "Change in Working Capital"],
    ["capitalExpenditure", "Capital Expenditure"],
    ["investingCashFlow", "Investing Cash Flow"],
    ["cashDividendsPaid", "Dividends Paid"],
    ["repurchaseOfCapitalStock", "Share Repurchases"],
    ["financingCashFlow", "Financing Cash Flow"],
    ["freeCashFlow", "Free Cash Flow"],
    ["changesInCash", "Net Change in Cash"],
    ["endCashPosition", "Ending Cash"],
  ],
};

/**
 * Build a statement from per-period records keyed by provider field names.
 * Drops sparse periods (under 40% of the best-covered period's lines, which
 * providers return for their oldest year), and lines empty in every period.
 */
export function buildStatement(
  security: string,
  statement: Statement,
  period: StatementPeriod,
  records: { date: string; values: Record<string, unknown> }[],
  source: string,
): FinancialStatement | null {
  const defs = STATEMENT_ROWS[statement];
  const value = (r: Record<string, unknown>, key: string) => {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const coverage = (r: (typeof records)[number]) => defs.filter(([key]) => value(r.values, key) !== null).length;
  const best = Math.max(0, ...records.map(coverage));
  const periods = records
    .filter((r) => {
      const n = coverage(r);
      return n > 0 && n >= 0.4 * best;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!periods.length) return null;
  const rows = defs
    .map(([key, label]) => ({ key, label, values: periods.map((p) => value(p.values, key)) }))
    .filter((row) => row.values.some((v) => v !== null));
  return { security, statement, period, columns: periods.map((p) => p.date), rows, source };
}
