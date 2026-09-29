// Deterministic offline filings and XBRL facts for PROVIDERS=mock, shaped like EDGAR's.

/** Form of the i-th most recent mock filing. */
export const MOCK_FORMS = ["4", "8-K", "10-Q", "4", "144", "SC 13G/A", "8-K", "10-K", "DEF 14A", "4", "S-8", "10-Q"];

const RISKS = [
  "Our operating results depend on consumer demand for connected devices, which can fall sharply during economic downturns.",
  "We depend on a small number of contract manufacturers in Asia, and disruptions at their facilities could delay shipments and raise costs.",
  "Changes in trade policy, including tariffs and export controls, could increase our costs.",
  "We face intense competition from companies with greater resources and broader product lines.",
  "Fluctuations in foreign exchange rates could reduce the dollar value of our international revenue.",
];
const RISKS_LATEST = [
  RISKS[0],
  RISKS[1],
  "Changes in trade policy, including new tariffs on semiconductors and wider export controls, could increase our costs and limit our sales in China.",
  RISKS[3],
  "New laws on artificial intelligence could restrict features in our products and require costly compliance programs.",
];

const p = (text) => `<p>${text}</p>`;
const heading = (text) => `<p style="font-weight:bold">${text}</p>`;
const toc = (rows) => `<table>${rows.map(([item, title, pg]) => `<tr><td>${item}</td><td>${title}</td><td>${pg}</td></tr>`).join("")}</table>`;

/** Revenue in USD millions for the mock fiscal year, growing 8% a year from FY2016. */
const revenueFor = (fy) => Math.round(50_000 * 1.08 ** (fy - 2016));

function annualReport(index) {
  const latest = index < MOCK_FORMS.length;
  const fy = 2025 - Math.floor(index / MOCK_FORMS.length);
  const revenue = revenueFor(fy);
  return [
    p("UNITED STATES SECURITIES AND EXCHANGE COMMISSION"),
    p(`FORM 10-K &mdash; Annual report for the fiscal year ended September 30, ${fy}`),
    p("Table of Contents"),
    toc([
      ["Item 1.", "Business", 3],
      ["Item 1A.", "Risk Factors", 8],
      ["Item 7.", "Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations", 20],
      ["Item 8.", "Financial Statements and Supplementary Data", 30],
    ]),
    heading("PART I"),
    heading("Item 1. Business"),
    p("Sample Registrant Inc. designs and sells connected devices, accessories and related services to consumers and businesses worldwide."),
    heading("Item 1A. Risk Factors"),
    p("The following risks could materially affect our business, financial condition and results of operations."),
    ...(latest ? RISKS_LATEST : RISKS).map(p),
    heading("PART II"),
    heading("Item 7. Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations"),
    p(`Net sales for fiscal ${fy} were $${revenue.toLocaleString("en-US")} million, an increase of 8% compared with fiscal ${fy - 1}, driven by higher device volumes.`),
    p("Gross margin was 45.2% of net sales, compared with 44.6% a year earlier, reflecting a more favorable mix of services."),
    heading("Item 8. Financial Statements and Supplementary Data"),
    p("The consolidated financial statements and the report of the independent registered public accounting firm follow."),
  ].join("\n");
}

function quarterlyReport(index) {
  return [
    p("FORM 10-Q &mdash; Quarterly report"),
    heading("PART I &mdash; FINANCIAL INFORMATION"),
    heading("Item 1. Financial Statements"),
    p("Condensed consolidated statements of operations, balance sheets and cash flows (unaudited) are presented below."),
    heading("Item 2. Management&#8217;s Discussion and Analysis of Financial Condition and Results of Operations"),
    p(`Net sales for the quarter increased ${7 + (index % 3)}% year over year, led by services, while device sales grew more slowly.`),
    heading("PART II &mdash; OTHER INFORMATION"),
    heading("Item 1. Legal Proceedings"),
    p("We are involved in legal proceedings arising in the ordinary course of business, none of which we expect to be material."),
    heading("Item 1A. Risk Factors"),
    p("There have been no material changes to the risk factors disclosed in our most recent annual report on Form 10-K."),
  ].join("\n");
}

function currentReport(filed) {
  return [
    p("FORM 8-K &mdash; Current report"),
    heading("Item 2.02 Results of Operations and Financial Condition."),
    p(`On ${filed}, Sample Registrant Inc. issued a press release announcing its financial results for the quarter, a copy of which is furnished as Exhibit 99.1.`),
    heading("Item 9.01 Financial Statements and Exhibits."),
    p("(d) Exhibits. 99.1 Press release issued by Sample Registrant Inc."),
  ].join("\n");
}

/** HTML of the primary document of the index-th most recent mock filing. */
export function mockDocumentHtml(index, filed) {
  const form = MOCK_FORMS[index % MOCK_FORMS.length];
  const body =
    form === "10-K" ? annualReport(index) : form === "10-Q" ? quarterlyReport(index) : form === "8-K" ? currentReport(filed) : p(`Form ${form} filed by Sample Registrant Inc.`);
  return `<html><head><title>${form}</title><style>p { margin: 0 }</style></head><body><div style="display:none"><ix:header>hidden XBRL facts</ix:header></div>${body}</body></html>`;
}

/** HTML of the Exhibit 99.1 earnings press release attached to a mock 8-K. */
export function mockPressReleaseHtml(index, filed) {
  const revenue = (14.2 + (index % 5) * 0.3).toFixed(1);
  const eps = (1.48 + (index % 5) * 0.04).toFixed(2);
  return [
    "<html><body>",
    p("<b>Sample Registrant Reports Quarterly Results</b>"),
    p(`SPRINGFIELD, Calif. &mdash; ${filed} &mdash; Sample Registrant Inc. today announced financial results for its fiscal quarter.`),
    p(`Revenue was $${revenue} billion, up 9 percent from a year ago. Diluted earnings per share were $${eps}, compared with $1.31 a year ago.`),
    p("Gross margin was 45.8 percent. Operating cash flow was $4.1 billion."),
    p("For the next quarter, the company expects revenue of $14.6 billion to $15.2 billion and gross margin between 45 and 46 percent."),
    p("The board of directors declared a quarterly dividend of $0.26 per share."),
    "</body></html>",
  ].join("\n");
}

/** A companyfacts document with ten fiscal years (ending September 30) and recent quarters. */
export function mockCompanyFacts(cik) {
  const entry = (start, end, val, fp, form, filed) => ({ start, end, val, accn: `0000${cik}-${filed.slice(2, 4)}-000001`, fy: Number(filed.slice(0, 4)), fp, form, filed });
  const years = Array.from({ length: 10 }, (_, i) => 2016 + i);
  const quarterEnds = (fy) => [
    [`${fy - 1}-10-01`, `${fy - 1}-12-31`, "Q1", 0.3],
    [`${fy}-01-01`, `${fy}-03-31`, "Q2", 0.24],
    [`${fy}-04-01`, `${fy}-06-30`, "Q3", 0.22],
  ];
  const flow = (share, { renamedBefore } = {}) => {
    const old = [];
    const current = [];
    for (const fy of years) {
      const target = renamedBefore && fy < renamedBefore ? old : current;
      const annual = revenueFor(fy) * 1e6 * share;
      target.push(entry(`${fy - 1}-10-01`, `${fy}-09-30`, annual, "FY", "10-K", `${fy}-11-01`));
      if (fy >= 2024) for (const [s, e, fp, part] of quarterEnds(fy)) target.push(entry(s, e, annual * part, fp, "10-Q", new Date(Date.parse(e) + 35 * 86_400_000).toISOString().slice(0, 10)));
    }
    return { old, current };
  };
  const revenue = flow(1, { renamedBefore: 2018 });
  // FY2024 restated in the FY2025 report: the later filing wins.
  revenue.current.push(entry("2023-10-01", "2024-09-30", revenueFor(2024) * 1e6 * 1.01, "FY", "10-K", "2025-11-01"));
  const usd = (entries) => ({ units: { USD: entries } });
  const eps = years.map((fy) => entry(`${fy - 1}-10-01`, `${fy}-09-30`, Number((revenueFor(fy) * 0.25 / 16_000).toFixed(2)), "FY", "10-K", `${fy}-11-01`));
  return {
    cik: Number(cik),
    entityName: "Sample Registrant Inc.",
    facts: {
      "us-gaap": {
        SalesRevenueNet: usd(revenue.old),
        RevenueFromContractWithCustomerExcludingAssessedTax: usd(revenue.current),
        OperatingIncomeLoss: usd(flow(0.3).current),
        NetIncomeLoss: usd(flow(0.25).current),
        NetCashProvidedByUsedInOperatingActivities: usd(flow(0.32).current),
        PaymentsToAcquirePropertyPlantAndEquipment: usd(flow(0.05).current),
        EarningsPerShareDiluted: { units: { "USD/shares": eps } },
        CashAndCashEquivalentsAtCarryingValue: usd(years.map((fy) => ({ end: `${fy}-09-30`, val: 20_000e6 + fy * 1e6, fp: "FY", form: "10-K", filed: `${fy}-11-01` }))),
      },
    },
  };
}
