# Contributing

Thanks for helping build BLMBU Terminal. Bug reports, new data providers, and new
terminal functions are all welcome.

## Setup

```bash
npm install
PROVIDERS=mock AI_PROVIDER=mock PLUGINS=./plugins/edgar npm run dev   # offline, no API keys needed
npm test && npm run test:e2e
```

Pull requests must pass CI, which runs the build, unit tests, and end-to-end tests
against the `mock` provider, the mock AI model, and the EDGAR plugin's fixtures.

Many features can ship as a plugin instead of a core change. See [PLUGINS.md](PLUGINS.md).

## Project layout

- `server/src/symbology.ts`: Bloomberg-style ticker parsing and mapping to provider symbols.
- `server/src/providers/`: data provider plugins and the `ProviderRouter`.
- `server/src/history/`: SQLite cache for price history.
- `server/src/stream/`: WebSocket hub for live quotes; `server/src/chat/`: IB/MSG chat.
- `server/src/research/`: API routes for research data, statement definitions, pricing
  math, the field dictionary (`fields.ts`), BQL (`bql.ts`), identifier resolution
  (`resolve.ts`), and the rule language shared by BTST and alerts (`rules.ts`).
- `server/src/portfolio/`: portfolio store, holdings-based analytics, routes.
- `server/src/ai/`: model clients (OpenAI-compatible, Anthropic, mock), the analyst's
  tools, and the agent loop behind `/api/ai/ask`.
- `server/src/alerts/`: server-side alert evaluation, delivered over the WebSocket.
- `server/src/userstore/`: saved sheets, workspaces, strategies and queries per user.
- `server/src/trading/`: the paper broker behind `TRADE`.
- `server/src/auth/`: optional sign-in (`AUTH=password`) and the gate that pins requests to the signed-in user.
- `server/src/cache/kv.ts`: persistent cache for slow-changing public data; `server/src/db.ts` opens the shared SQLite file.
- `server/src/providers/`: besides the providers themselves, `centralBanks.ts` (overnight rates), `sovereign.ts` (government curves),
  `newsFeeds.ts` (RSS), `wikipedia.ts` (index members) and `usage.ts` (per-source request counts and free-tier limits).
- `server/src/research/`: also `members.ts` (MEMB), `wirp.ts` (WIRP), `forwards.ts`/`fxmath.ts` (FRD), `brief.ts` (BRIEF) and `sources.ts` (SRC).
- `server/src/plugins/`: plugin SDK types, loader, screen-spec validation and routes;
  `plugins/`: bundled plugins.
- `client/src/terminal/`: command parser, keymap, function list, formula engine,
  backtester, clipboard table parsing.
- `client/src/screens/`: one component per terminal function, registered in `screens/index.tsx`.
- `client/src/components/`: panel chrome, command line, charts, the spreadsheet `Grid`,
  and the command palette.

## Adding a terminal function

1. Add the mnemonic to `client/src/terminal/functions.ts` (and to a sector menu if it
   operates on a security).
2. Write a screen component in `client/src/screens/` using the helpers in `common.tsx`
   (`DataTable` for paged tables, `useOptions`/`OptionBar` for numbered choices,
   `DataState` for loading and errors).
3. Register it in `SCREEN_REGISTRY`, with `sectors` if it only applies to some.
4. Add it to the end-to-end list in `client/e2e/functions.spec.ts`. A test there fails
   when a function in the list has no render check.
5. If the AI analyst should be able to open it, it already can: `open_function` accepts
   any code in the function list.

## Adding a data provider

1. Create `server/src/providers/<id>.ts` exporting a function that returns a
   `ProviderPlugin` (defined in `server/src/providers/DataProvider.ts`):

   ```ts
   export function createMyProvider(apiKey: string): ProviderPlugin {
     return {
       id: "myprovider",
       requiresKey: "MYPROVIDER_API_KEY",
       sectors: ["Equity", "Index"],
       async quotes(securities) { /* ... */ },
       async search(query) { /* ... */ },
       async history(security, interval, from, to) { /* ... */ },
     };
   }
   ```

   Besides quotes, search and history, a plugin can offer research capabilities
   (`profile`, `financials`, `earnings`, `analysts`, `holders`, `events`, `options`,
   `related`, `valuations`, `futuresChain`, `companyNews`) and market-wide ones (`news`,
   `topNews`, `screen`, `yieldCurve`, `moneyMarkets`, `econStats`, `econCalendar`); their
   result types are in `server/src/types.ts`. Implement only the capabilities the source
   supports. The router skips plugins that lack a capability or do not cover a security's
   sector, and the `mock` provider must keep covering every capability so CI stays offline. Securities arrive in canonical
   Bloomberg form (`AAPL US Equity`); use `server/src/symbology.ts` to map them. Omit
   securities you cannot price, and throw only on real failures, so the router can fall
   back to the next provider.

2. Add the id to `KNOWN_PROVIDERS` in `server/src/config.ts`, and register it in
   `PLUGIN_FACTORIES` in `server/src/providers/index.ts`. (A provider for a source with
   restrictive terms, or one few users need, can ship as a plugin instead. See
   [PLUGINS.md](PLUGINS.md).)

   ```ts
   myprovider: { requiresKey: "MYPROVIDER_API_KEY", create: (c) => createMyProvider(c.keys.MYPROVIDER_API_KEY!) },
   ```

3. If it needs a key, read it into `keys` in `loadConfig`, and document it in
   `.env.example` and the README configuration table.
4. Document the source's licensing terms in the README's "Data licensing" section.
5. Add unit tests. Mock network calls; CI has no access to external APIs.

## Code style

- TypeScript strict mode, no `any` in new code.
- Keep comments for constraints the code cannot express.
- Match the surrounding code's naming and structure.
