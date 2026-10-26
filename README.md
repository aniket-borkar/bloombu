# BLMBU Terminal

A free, open-source, self-hosted market terminal modeled on the Bloomberg Terminal's
keyboard-driven workflow: amber-on-black panels, a command line with `<GO>`, yellow
market-sector keys, and Bloomberg-style tickers (`AAPL US <EQUITY>`, `SPX <INDEX>`,
`EURUSD <CRNCY>`, `CL1 <CMDTY>`).

Not affiliated with Bloomberg L.P.

## Beyond the Bloomberg workflow

- **A connected investment research lab.** `VAL` models an equity's value from
  explicit earnings or unlevered cash-flow assumptions, with an auditable forecast
  and sensitivity grid. `SCEN` applies hypothetical market, sector, security and
  currency shocks to a saved portfolio, explaining price, FX and interaction
  effects for every holding. Capture either analysis in `NOTE` alongside your
  thesis, bear case, catalysts, review date and source evidence. Notebooks retain
  the original assumptions and results when markets later change, support export,
  and reject conflicting saves from an older revision.
- **Portfolios you can paste.** Copy holdings from Excel or Google Sheets and press
  Ctrl/Cmd+V in `PRTU`. Column headers such as Ticker, Shares and Cost are recognized, and
  holdings can be identified by Bloomberg ticker (`VOD LN`), Yahoo symbol (`VOD.L`), US
  Reuters code (`AAPL.O`), ISIN or company name. `PORT` then shows holdings in your base currency, performance against a
  benchmark, risk (volatility, beta, tracking error, VaR/CVaR, drawdown, correlations),
  exposures, attribution, and what-if trades. Use real positions (shares) or model
  weights.
- **An AI analyst that uses the terminal.** Type `? compare AAPL and MSFT margins` on any
  command line. The analyst calls the same data functions you do (fields, history,
  financials, estimates, news, screens, BQL, your portfolios), streams its answer, and can
  open functions in the next panel or draft a portfolio for you. It works with OpenAI or
  any OpenAI-compatible API, Anthropic, or a free local model via Ollama.
- **Research, not just lookups.** `?? question` starts deep research: the analyst plans the
  work and runs independent lookups in parallel. It backtests rules across several securities
  with an out-of-sample split, and measures beta, correlations and factor loadings with
  t-statistics. It turns plain English into BQL screens and alerts that you open in `BQL` or
  confirm with one click, and it lists the source of every figure under its answer. With the
  EDGAR plugin it also reads 10-K and 10-Q sections, shows what changed in risk factors since
  last year, and reads the latest earnings release.
- **A live spreadsheet and a query language.** `SHEET` supports `=BDP(...)`, and
  `=BDH(...)` history that spills into neighboring cells, with Excel copy and paste.
  `BQL` runs SQL-like queries over screens, indices, portfolios and lists.
  `FLDS` documents every field.
- **Backtests.** `BTST` tests entry and exit rules written in plain expressions, such as
  `crossAbove(sma(close, 50), sma(close, 200))`, with trading costs, and compares the
  result with buy-and-hold.
- **Server-side alerts.** `ALRT` watches price, percent-move, volume and rule conditions
  even when your browser is closed. Alerts arrive as a status-bar toast and an optional
  desktop notification.
- **Workspaces.** Layouts of 1 to 9 panels, color-linked panel groups that follow one
  security, pop-out windows, a Ctrl/Cmd+K command palette, and saved workspaces.
- **Plugins.** Add functions, data providers and AI analyst tools without forking. The
  bundled SEC EDGAR plugin adds `CF` (company filings) and filing tools for the analyst.
  See [PLUGINS.md](PLUGINS.md).

## Research lab workflow

1. Load an equity and run `VAL`. The earnings model discounts an assumed dividend
   stream and an exit earnings multiple. A reference EPS may be inferred from a
   positive quote divided by trailing P/E; that inference is labeled separately
   from reported data. Change growth, horizon, payout, required return and the
   terminal multiple to inspect the forecast and sensitivity.
2. For enterprise DCF, supply **unlevered free cash flow to the firm**, WACC,
   terminal growth, net debt and diluted shares. Cash flows, net debt and quote
   must use consistent currency units; share counts must correspond to the
   listing. Reported operating cash flow minus capex is not silently treated as
   FCFF. Forecast cash flows and terminal value are discounted at year end;
   equity value is enterprise value less net debt. See
   [Damodaran's firm cash-flow valuation model](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/fcff.html).
3. Create a portfolio in `PRTU`, then open `SCEN`. Price shocks compound across
   the market, sector and security; FX shocks measure the change in base-currency
   value of a foreign currency. The lab preserves duplicate lots and short
   positions, reconciles price/FX/interaction effects, and flags unvalued holdings.
   These are instantaneous hypothetical shocks, not historical-crisis replicas
   or derivative repricing models.
4. Capture a result into `NOTE`, add the thesis and counterarguments, attach
   source URLs and review dates, then explicitly save. Export snapshots for
   independent review. Captures retain their original values and observation
   times; an updated market quote does not rewrite your evidence. Revision
   conflicts preserve your local draft so you can inspect the newer version.

The lab needs no new subscription or AI provider. Review dates are recorded in
the notebook; they do not create scheduled notifications.

Notebook saves use `CACHE_DB`, like portfolios and sheets. The source setup and
Docker volume persist that SQLite file. The Vercel adapter's default `/tmp` file
is instance-local and temporary; persistent production research on that platform
requires shared durable storage. Exports provide an independent copy of a draft.

## How it stays free

- **No central servers.** Everyone runs their own copy (laptop, home server, or a free
  cloud tier), so the project has no hosting bill to recover.
- **No data resale.** Your instance reads free sources directly: official publishers
  (US Treasury, Federal Reserve, New York Fed, ECB, Bank of England, Bank of Japan, SNB,
  Bank of Canada, RBA, Japan's Ministry of Finance, World Bank, SEC), open data
  (Wikipedia), public market data (Coinbase), and Yahoo Finance for personal use.
- **Your own free keys, if you want more.** Finnhub (real-time US trades) and FRED
  (economic calendar) have free tiers. `SRC <GO>` shows what each source covers and what
  a free key would add.
- **Free-tier guardrails.** The server counts every request per source and never goes
  over a free tier's limit. It switches to the next source instead, and caches
  slow-changing data (index members, central-bank rates, calendars) in SQLite across
  restarts.
- **Free AI.** The analyst runs on a local model through Ollama at no cost. Hosted models
  are optional.

## Quick start

### Docker (recommended)

```bash
cp .env.example .env        # optional: add API keys, choose providers
docker compose up --build
```

Open <http://localhost:8787> (set `HOST_PORT` in `.env` to change the port). The app,
API, and WebSocket are served from that single port. Price history is cached in the
`blmbu-data` Docker volume, so it survives restarts.

### From source

Requires Node 22.13 or newer.

```bash
npm install
npm run dev                 # server on :8787, client on :5173
```

Open <http://localhost:5173>. Press `<GO>` (Enter) on the login screen; no account is needed.

To run offline with simulated prices: `PROVIDERS=mock npm run dev`.

## Keyboard

| Key | Terminal key |
| --- | --- |
| Enter | `<GO>` |
| Esc | `<CANCEL>` |
| F1 | `<HELP>` |
| Backspace (empty command line) | `<MENU>` (back) |
| Alt+Left / Alt+Right | Back / forward |
| F2 to F11 | GOVT, CORP, MTGE, M-MKT, MUNI, PFD, EQUITY, CMDTY, INDEX, CRNCY |
| Tab / Shift+Tab | Next / previous panel |
| PgDn / PgUp | Page forward / back |
| Ctrl/Cmd+K | Command palette: functions, securities, portfolios, sheets, recent screens, layouts |
| `? question` then Enter | Ask the AI analyst from any command line |
| `?? question` then Enter | Deep research: the analyst states a plan and runs a longer, multi-step analysis |
| Ctrl/Cmd+C, Ctrl/Cmd+V | Copy and paste cell ranges in `PRTU`, `SHEET` and `BQL` grids (tab-separated, Excel compatible) |

The key strip at the bottom of the screen is clickable, which helps on keyboards where
F-keys need a modifier. On screens with numbered options (chart ranges, statement views,
option expiries, chat rooms), type the number and press `<GO>`, or click it.

Each panel's title bar has a link square (click to cycle amber, green, blue, red, none).
Loading a security in a linked panel loads it in every panel of the same color, and each
keeps its own function. The ⧉ button pops the panel out into its own window.

## Functions

Type a mnemonic and press `<GO>`. Security functions act on the panel's loaded security.

| Area | Functions |
| --- | --- |
| Quotes & charts | `DES` description, `BQ` composite quote, `GP` price graph, `GIP` intraday graph, `GPO` candlestick chart, `HP` price history table |
| Company | `FA` financial statements, `EE` estimates, `ERN` earnings history, `ANR` analyst ratings and targets, `HDS` holders, `DVD` dividends and splits, `MGMT` officers, `RV` relative valuation, `RELS` other listings, `CN` company news |
| Analytics | `BETA` historical beta, `TRA` total return, `OMON` option chain, `OVML` option valuation (Black-Scholes), `YAS` bond yield and risk, `CT` futures contract table, `QR` live time and sales (crypto free; US stocks with a free Finnhub key), `MEMB` index members with weights and point contributions, `FRD` FX forwards from official overnight rates |
| Markets | `WEI`/`W` world indices, `IMAP` sector map, `MOST` most active, `EQS` predefined screens, `WCRS` currency ranker, `FXC` FX cross rates, `GLCO` commodities, `GC` yield curves (US, euro area, Japan, Canada, UK), `BTMM` Treasury and money markets, `WB` world government bonds, `WIRP` Fed rate probabilities by meeting |
| News & economics | `TOP` top news merged from Yahoo, CNBC, MarketWatch, the Fed, the ECB and the SEC, `N` news by topic, `ECST` world economic statistics, `ECO` economic calendar (needs `FRED_API_KEY`) |
| Collaboration | `IB` chat rooms and direct messages, `MSG` direct messages, `BLP` personal monitor (watchlist) |
| Portfolios | `PRTU` create and edit portfolios (paste from Excel), `PORT` portfolio and risk analytics |
| Data tools | `SHEET` live spreadsheet (`BDP`, `BDH`), `BQL` query language, `FLDS` field dictionary |
| Research | `ASK` AI analyst, `BTST` strategy backtester, `ALRT` alerts, `BRIEF` personal daily briefing, `VAL` valuation lab, `SCEN` portfolio scenario lab, `NOTE` evidence-linked research notebooks |
| Trading | `TRADE` paper trading against live quotes (positions flow into `PORT`) |
| Workspace | `LAYOUT` panel layouts, link groups and saved workspaces, `SRC` data sources and free-tier usage, `HELP` |
| Plugins | `CF` SEC company filings (with `PLUGINS=./plugins/edgar`), plus anything your plugins add |

`SPLC` (supply chain) is the one function without a free data source; it explains why when
opened. `FRD` forwards are theoretical (covered interest parity from central-bank overnight
rates) rather than dealer quotes, and `MEMB` weights are estimated from market caps; both
screens say so.

`IB`/`MSG` connect users of the same self-hosted instance. Your login name on the splash
screen is your chat name. Portfolios, sheets, strategies, workspaces and alerts are also
stored under that name. There is no authentication, so anyone who can reach the server
can use any name. Only run it for people you trust.

## Configuration

All settings are environment variables, read from `.env` at the repo root. See
[.env.example](.env.example) for the full list.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROVIDERS` | `kraken,coinbase,public,yahoo` | No sign-up or keys required. Public crypto streams and official sources precede Yahoo snapshots. Explicit lists keep their exact order |
| `FINNHUB_API_KEY` | | Required to enable the `finnhub` provider |
| `FRED_API_KEY` | | Optional. Enables the `ECO` economic calendar via the `public` provider |
| `PORT` | `8787` | Server port when running from source |
| `HOST_PORT` | `8787` | Published port with Docker Compose |
| `CACHE_DB` | `data/cache.db` | SQLite file for cached history, portfolios, sheets, alerts and chat (`:memory:` to disable persistence) |
| `STREAM_INTERVAL_MS` | `5000` | How often streamed quotes are refreshed from polling providers, and alerts are checked |
| `AI_PROVIDER` | | `openai` (or any OpenAI-compatible API), `anthropic`, `ollama`, or `mock`. Empty turns `ASK` off |
| `AI_API_KEY` | | Required for `openai` and `anthropic` |
| `AI_MODEL` | | Model name, required for every provider except `mock` (for Ollama, one with tool calling, such as `llama3.1`) |
| `AI_MODEL_DEEP` | `AI_MODEL` | Optional stronger model from the same provider for deep research questions (`?? question`) |
| `AI_BASE_URL` | | Endpoint override, e.g. `https://api.groq.com/openai/v1`. Ollama defaults to `http://localhost:11434/v1` |
| `PLUGINS` | | Comma-separated plugin paths (from the repo root) or package names, e.g. `./plugins/edgar` |
| `SEC_USER_AGENT` | | Your name and email, sent to the SEC by the EDGAR plugin as the SEC requires |
| `CONTACT` | `SEC_USER_AGENT` | Name and email for the User-Agent that Wikipedia and other public APIs ask clients to send |
| `AUTH` | | `password` to require sign-in; unset leaves the terminal open to anyone who can reach it |
| `AUTH_SIGNUP` | `open` | `closed` stops new accounts once the first account exists |

For each request the server uses the first provider in `PROVIDERS` that supports the
security's market sector, and falls back to the next one on error.

### Keyless streaming data

The terminal and adapters are MIT licensed. The default data path needs no sign-up,
API keys or paid subscription. Data licenses remain separate from the code license.
Repository visibility is controlled independently; this update does not change it.

When Kraken is the first configured crypto provider, the browser connects directly
to its official public WebSocket v2 ticker, removing the server relay hop for quotes.
The server stays subscribed until the browser receives a valid direct quote. A
blocked, closed or silent direct stream restores server delivery; a healthy direct
stream can take over again. The security header shows `Direct feed` or `Server feed`.
The server continues to handle trade tapes, alerts and paper orders. Coinbase is an
independent REST fallback. Both public feeds require no account or API key. Quotes
identify the exchange because venue prices can differ.
See [Kraken's public ticker stream](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ticker)
and [public trade stream](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/trade).

The `public` provider supplies official macroeconomic data and press feeds from
central banks and the SEC, plus public financial headlines. TOP checks for new
headlines every minute, with shared server caching. Publisher release times and
network availability still determine when a story becomes available.

Stocks, indices, FX, futures, history and company research still use Yahoo where
the keyless sources do not provide coverage. This configuration does not include
a real-time consolidated US stock trade tape. To omit Yahoo entirely, use
`PROVIDERS=kraken,coinbase,public`; unsupported markets become unavailable rather
than receiving substituted or simulated prices. Existing Finnhub/FRED adapters
remain optional and are excluded from the keyless default.

Native updates are forwarded when they arrive, without waiting for the polling
interval. After 15 seconds without a native update, the server checks REST
snapshots until streaming resumes. Requests respect each public source's budget.
A slow snapshot cannot replace a newer streamed price. `SRC <GO>` shows
active sources and coverage. Each security's
header shows its actual provider, source timestamp, delay and quote age; quote age
also grows when an exchange is closed or a security does not trade, and is not a
network-latency measurement. No end-to-end latency guarantee is implied.

Direct quote callbacks run as messages arrive; there is no polling timer or frame
delay inserted into that data path. Browser rendering still follows the display's
refresh cycle. For example, a 60 Hz screen has a 16.7 ms frame interval. Public feed
publication, internet transit, browser scheduling and painting are separate from
the terminal's own dispatch CPU time; sub-millisecond CPU processing does not mean
sub-millisecond exchange-to-screen delivery.

Run `npm run bench:quotes` for a warmed local benchmark of timestamp validation,
change detection, JSON serialization and message enqueueing. It reports p50, p95,
p99 and maximum across recipient/idle-client workloads. It excludes exchange,
network, real socket work and browser paint; its percentiles are measurements, not
hard latency guarantees. Run `npm run bench:public-feed` to measure the public feed's WebSocket ping
round trip separately. Neither benchmark fabricates market updates.

No new environment variables are required. An existing custom `PROVIDERS` list
must include `kraken` to enable it. A single self-hosted Node/Docker process can
keep public streams open continuously; serverless deployments may reconnect as
function instances start and stop.

The AI analyst sends your questions, plus the data its tools fetch, to the model provider
you configure. With `ollama`, everything stays on your machine.

## Data licensing

BLMBU ships no market data. Each user runs their own instance and supplies their own
access to data sources, and is responsible for complying with those sources' terms:

- **Coinbase** (`coinbase`): no key. Real-time crypto prices and trades from Coinbase's
  public market data; see Coinbase's API terms.
- **Kraken** (`kraken`): public crypto ticker and trade channels, no account or key.
  Exchange-specific data remains subject to Kraken's API/data terms.
- **Yahoo Finance** (`yahoo`, via the unofficial `yahoo-finance2` library): no key
  needed. Yahoo's terms prohibit redistribution, so suitable for personal use only.
- **Finnhub** (`finnhub`): free API key from finnhub.io. The free tier covers mainly US
  equities; see Finnhub's terms for redistribution limits.
- **Public** (`public`): no key.
  - US Treasury daily yield curve and the Fed's FOMC calendar (US government data).
  - Central-bank reference rates and yields from the New York Fed, ECB, Bank of England,
    Bank of Japan, Swiss National Bank, Bank of Canada, Reserve Bank of Australia, and
    Japan's Ministry of Finance. Each publisher's reuse terms apply, usually attribution.
  - World Bank Open Data (CC BY 4.0).
  - Index members from Wikipedia (CC BY-SA 4.0) and nasdaq.com.
  - Headlines from the Fed, ECB and SEC press feeds, and from CNBC and MarketWatch RSS
    (for personal reading).
  - With `FRED_API_KEY`, the FRED release calendar (see the FRED terms of use).
- **Mock** (`mock`): deterministic simulated prices and research data for development,
  demos, and CI. Simulated headlines are marked `[SIMULATED]`.

Do not run a public, multi-user instance on top of sources that forbid redistribution.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/quote/:security` | Snapshot quote, e.g. `/api/quote/AAPL%20US%20Equity` |
| `GET /api/search?q=` | Security search, results in Bloomberg ticker format |
| `GET /api/history/:security?interval=1d&range=1y` | OHLCV bars. Intervals `1m 5m 1h 1d 1wk`; ranges `1d 5d 1mo 3mo 6mo 1y 2y 5y` |
| `GET /api/indices` | Quotes for the status-bar ticker tape |
| `GET /api/quotes?s=A,B` | Batch quotes (up to 100) |
| `GET /api/profile/:security` | Description and key statistics |
| `GET /api/financials/:security?statement=income\|balance\|cashflow&period=annual\|quarterly` | Financial statements |
| `GET /api/earnings/:security`, `/api/analysts/:security`, `/api/holders/:security`, `/api/events/:security` | Estimates, ratings, holders, dividends and splits |
| `GET /api/options/:security?expiration=ISO` | Option chain |
| `GET /api/related/:security`, `/api/valuations?s=`, `/api/listings/:security` | Peers, valuation multiples, other listings |
| `GET /api/futures/:security` | Futures contract months for a generic, e.g. `CL1 Comdty` |
| `GET /api/news/company/:security`, `/api/news?q=`, `/api/news/top` | Headlines |
| `GET /api/screens/:id` | Predefined screens (`most_actives`, `day_gainers`, ...) |
| `GET /api/curve`, `/api/money-markets`, `/api/econ/stats`, `/api/econ/calendar` | Rates and economics |
| `GET /api/providers` | Active providers and their capabilities |
| `POST /api/resolve` | Identify free-form tickers: `{"inputs":["AAPL","VOD LN","^GSPC"]}` |
| `GET /api/fields/list`, `GET /api/fields?s=A,B&f=PX_LAST,PE_RATIO` | Field dictionary and batch field values |
| `POST /api/bql` | Run a query: `{"query":"SELECT NAME, PX_LAST FROM wei() ORDER BY CHG_PCT_1D DESC","user":"ME"}` |
| `GET\|POST /api/portfolios`, `GET\|PUT\|DELETE /api/portfolios/:id` | Portfolios (pass `user`) |
| `GET /api/portfolios/:id/analytics?range=1y&benchmark=SPX%20Index`, `POST /api/portfolios/:id/whatif`, `POST /api/portfolios/analytics` | Portfolio analytics, what-if and unsaved-portfolio analytics |
| `GET /api/docs/:kind`, `GET\|PUT\|DELETE /api/docs/:kind/:name` | Saved sheets, workspaces, strategies and queries per user |
| `GET\|POST /api/alerts`, `DELETE /api/alerts/:id`, `POST /api/alerts/:id/rearm` | Alerts per user |
| `GET /api/ai/status`, `POST /api/ai/ask` | AI analyst status, and a streamed answer (server-sent events) |
| `GET /api/plugins`, `GET /api/plugins/run/:code?security=&option=` | Loaded plugins, and plugin function screens |
| `GET /api/members/:index`, `GET /api/wirp`, `GET /api/forwards/:pair`, `GET /api/rates/overnight`, `GET /api/curves` | Index members, Fed rate probabilities, FX forwards, central-bank overnight rates, government curves |
| `GET\|POST /api/paper`, `POST /api/paper/orders`, `DELETE /api/paper/orders/:id`, `POST /api/paper/reset` | Paper trading account and orders (pass `user`) |
| `GET /api/brief?user=`, `GET /api/sources` | Personal briefing; data sources with free-tier usage |
| `GET\|POST /api/research/valuation/:security` | Reference observations, or an earnings/FCFF valuation from explicit assumptions |
| `POST /api/portfolios/:id/scenario` | Hypothetical market/sector/security/FX shocks; owned portfolio and `user` required |
| `GET\|POST /api/notebooks`, `GET\|PUT\|DELETE /api/notebooks/:id` | Evidence-linked notebooks per user; updates and deletes require the current `revision` |
| `GET /api/auth/me`, `POST /api/auth/register\|login\|logout` | Sign-in (with `AUTH=password`) |
| `WS /ws` | Live quotes: `{"op":"sub","securities":["AAPL US Equity"]}`; trades: `{"op":"trades.sub","security":"XBTUSD Curncy"}`; chat: `{"op":"chat.join","room":"#general","user":"ME"}`; alerts and paper fills: `{"op":"hello","user":"ME"}` |

## Development

```bash
npm test            # server and client unit tests
npm run test:e2e    # Playwright end-to-end tests (offline: simulated data, mock AI, EDGAR fixtures)
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a data provider or a function, and
[PLUGINS.md](PLUGINS.md) for extending the terminal without changing its code.

## Development direction

This research-lab release is the first step toward a broader terminal. Further
work should be measured against complete investor workflows: time to a sourced
analysis, visible coverage gaps, accurate units and timestamps, reproducibility
of saved research, and reliable monitoring of a thesis over time.

- **Data quality:** provider provenance and freshness, corporate-action-aware
  history, filing revisions, and point-in-time fundamentals for unbiased studies.
- **Research monitoring:** connect catalysts and saved assumptions to earnings,
  filings, news changes and explicit user-controlled alerts.
- **Repeatable studies:** walk-forward evaluation, transaction-cost models,
  benchmark comparisons and reusable research workflows.
- **Durable collaboration:** notebook history, shared evidence, recovery/backups,
  and shared persistent storage for cloud deployments.
- **Broader market coverage:** evaluate licensed exchange data, fundamentals and
  execution integrations against documented coverage, latency and entitlement
  requirements. No new paid service is configured by this release.

## License

[MIT](LICENSE)
