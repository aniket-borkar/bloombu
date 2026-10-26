# Plugins

Plugins extend BLMBU Terminal without forking it. A plugin is an ES module that can add:

- **Functions**: new `<GO>` codes that behave like built-in ones. They show up in security menus, HELP, the Ctrl/Cmd+K palette and linked panels, with a numbered option bar if you want one. A plugin returns a *screen spec* (text, key/value pairs, tables, charts) and the terminal renders it with its own components, so plugins ship no UI code.
- **Data providers**: new sources for any capability the built-in providers have (quotes, history, search, profile, financials, news, curves, and so on).
- **AI tools**: tools the AI analyst (`ASK`, `? question`) can call, for example to read documents your plugin can fetch. Their summaries and sources appear under the analyst's answer.

The repository ships one example, [`plugins/edgar`](plugins/edgar/index.mjs). It adds **CF** (Company Filings), which lists every recent SEC filing of a US-listed company, filterable by type, with click-through to sec.gov. It also adds a provider that turns 8-K/10-Q/10-K filings into company news when the other providers have none. For the AI analyst, it adds tools that read filing sections, compare risk factors between years, return ten years of XBRL financials, and read the latest earnings press release.

> Plugins run inside the server process with its full permissions. Only install plugins you trust.

## Enabling plugins

Set `PLUGINS` to a comma-separated list, in `.env` or the environment:

```sh
PLUGINS=./plugins/edgar
SEC_USER_AGENT="Your Name you@example.com"   # the SEC asks every client to identify itself
```

Each entry is either:

- a **path** starting with `.` or `/`, resolved from the repository root. It may be a file, or a directory with a `package.json` `main` or an `index.mjs`/`index.js`; or
- a **package name** installed in the server workspace (`npm install -w server blmbu-plugin-foo`).

The server logs each plugin it loads. A plugin that fails to load or validate stops startup with a message naming it. `GET /api/plugins` lists what is loaded.

With Docker, the `plugins/` directory is copied into the image. To add your own plugin, put it there before building, or mount it and point `PLUGINS` at the mount path.

## Writing a plugin

A minimal plugin that adds a market-level function:

```js
// plugins/hello/index.mjs
export default {
  name: "hello",
  functions: [
    {
      code: "HELLO",
      name: "Hello World",
      security: false,
      run: () => ({ blocks: [{ type: "text", text: "Hello from a plugin" }] }),
    },
  ],
};
```

Start the server with `PLUGINS=./plugins/hello` and type `HELLO <GO>`.

The default export can also be a function, optionally async, that receives a context and returns the plugin. Use this form when the plugin needs configuration:

```js
/** @param {import("../../server/src/plugins/sdk.ts").PluginContext} ctx */
export default function myPlugin(ctx) {
  const apiKey = ctx.env.MY_VENDOR_KEY;
  if (!apiKey && !ctx.mock) throw new Error("set MY_VENDOR_KEY");
  return { name: "my-vendor", functions: [/* ... */], providers: [/* ... */] };
}
```

| Context field | Meaning |
| --- | --- |
| `mock` | `true` when `PROVIDERS` includes `mock`. Return fixture data and make no network calls, so tests and demos work offline. |
| `env` | The server environment, for API keys and settings. |
| `log(message)` | Write to the server log. |
| `cache` | `cache.wrap(key, ttlMs, load)` returns a cached JSON value, loading it once when missing or expired. The server's SQLite cache keeps it across restarts, and keys are private to your plugin. It can be absent (for example in tests), so fall back to fetching. |

The full contract, as TypeScript types, is in [`server/src/plugins/sdk.ts`](server/src/plugins/sdk.ts) and [`server/src/plugins/spec.ts`](server/src/plugins/spec.ts). Plain JavaScript plugins can reference them with JSDoc, as the EDGAR plugin does, to get editor completion.

### Functions

```js
{
  code: "CF",                 // 1-8 characters, A-Z and 0-9, starting with a letter
  name: "Company Filings",
  security: true,             // runs on the panel's loaded security
  sectors: ["Equity"],        // optional: sectors a security function supports
  options: ["All", "10-K"],   // optional: numbered option bar (at most 9); "2 <GO>" selects 10-K
  async run({ security, option, router, signal }) {
    // security: normalized, e.g. "AAPL US Equity" (null for market-level functions)
    // option:   index into options (0 if there are none)
    // router:   the terminal's data router, e.g. await router.quotes(["SPX Index"])
    // signal:   aborted after 20 s or when the user leaves the screen; pass it to fetch
    return { title: "Optional heading", blocks: [/* ... */] };
  },
}
```

A function code that the terminal already uses is skipped, with a warning in the browser console. A code defined by two plugins stops startup.

Throwing an error shows your message in the panel. For example, `throw new Error("VENDOR RATE LIMIT, TRY AGAIN IN A MINUTE")`.

### Screen spec

A screen is `{ title?, blocks: Block[] }` with up to 20 blocks, rendered top to bottom. Every block takes an optional `title`, which is shown as a section header.

```js
{ type: "text", text: "Paragraph of explanation or attribution." }

{ type: "kv", items: [["Company", "Apple Inc."], ["CIK", "320193"], ["Employees", 150000]] }

{
  type: "table",
  columns: [
    { key: "filed", label: "Filed", format: "date" },             // ISO date or epoch ms -> MM/DD/YY
    { key: "form", label: "Form" },
    { key: "amount", label: "Amount", format: "number", decimals: 1 },
    { key: "yield", label: "Yield", format: "pct" },              // 4.25 -> 4.25%
  ],
  rows: [{ filed: "2026-09-24", form: "10-K", amount: 1234.5, yield: 4.25, url: "https://..." }],
  linkKey: "url",           // optional: clicking a row opens this http(s) URL
  securityKey: "security",  // optional: clicking a row loads this security, e.g. "MSFT US Equity"
}

{
  type: "series",
  unit: "number",           // or "pct"
  series: [{ label: "Revenue", points: [{ t: "2025-12-31", v: 124.3 }, { t: 1767225600000, v: 130.1 }] }],
}
```

The largest table on a screen is paged with <PAGE FWD>/<PAGE BACK>, like built-in tables. The server validates every screen before sending it:

- Unknown fields are dropped.
- Cell values must be strings, numbers, booleans, dates or null.
- Links must be http(s).
- Sizes are capped at 5,000 rows, 30 columns, 8 series and 20,000 points per series.

An invalid screen shows a message saying what is wrong, for example `CF RETURNED AN INVALID SCREEN: block 2 has unknown type "chart"`.

### Data providers

A provider implements any subset of the capabilities in [`server/src/providers/DataProvider.ts`](server/src/providers/DataProvider.ts), and declares the market sectors it can price:

```js
providers: [
  {
    id: "my-vendor",                 // lowercase, unique
    sectors: ["Equity", "Index"],
    async quotes(securities) { /* return Quote[] for the ones you cover */ },
    async history(security, interval, from, to) { /* return Bar[] */ },
  },
],
```

For each request, the router tries providers in priority order. It uses the first non-empty result, and falls through on errors and empty results. Plugin providers come after the built-in `PROVIDERS` as fallbacks. To give one a different priority, list its id in `PROVIDERS`, for example `PROVIDERS=my-vendor,yahoo,public`.

A provider can declare `rateLimit: { perMinute: 55, perDay: 1000 }`; either limit is optional. The router reserves capacity before calling it, so concurrent operations share the budget. By default, one provider operation counts as one request.

If an operation makes several HTTP requests, or native subscriptions fetch snapshots, implement `setUsageMeter(meter)` and wrap **each** outgoing request in `meter.run(providerId, rateLimit, async () => { /* fetch and parse response */ })`. This opts the provider into request-level accounting; the router then leaves metering to the provider. Cache hits and WebSocket messages do not consume HTTP request capacity. Return successful symbols from a partially completed batch so the router can try other sources for the rest.

### AI tools

An AI tool is offered to the analyst's model next to the built-in tools. The model decides when to call it from its `description` and `parameters`:

```js
aiTools: [
  {
    spec: {
      name: "vendor_estimates",   // lowercase letters, digits and _, starting with a letter
      description: "Consensus estimates from My Vendor for a US equity. Use for questions about forecasts.",
      parameters: {               // JSON Schema for the arguments object
        type: "object",
        properties: { security: { type: "string", description: 'e.g. "AAPL US Equity"' } },
        required: ["security"],
      },
    },
    async run(args, { router, signal, maxResultChars }) {
      // args:           what the model sent; validate it, since a model can send anything
      // router:         the terminal's data router
      // signal:         aborted after 30 s; pass it to fetch
      // maxResultChars: how much of the result's JSON the model will see; size text pages to fit
      const data = await fetchEstimates(String(args.security), signal);
      return {
        result: data,                                             // JSON for the model
        summary: `Loaded My Vendor estimates for ${args.security}`, // shown to the user
        sources: [{ label: "My Vendor estimates", url: "https://vendor.example/aapl", asOf: data.date }],
      };
    },
  },
],
```

- A name that is already a built-in analyst tool, or that another plugin defines, stops startup.
- Keep `result` compact: the analyst cuts each result off after `maxResultChars` characters (8,000, or 16,000 for deep research with `?? question`). Return the part that answers the question, with an offset or filter argument for the rest, as the EDGAR plugin's `read_filing` does.
- Throwing an error passes its message to the model, which can retry with other arguments or explain the problem to the user.
- Sources are listed under the answer. Links must be http(s), and malformed entries are dropped.
- In mock mode (`ctx.mock`), return fixture data, as for functions.

## Testing a plugin

Run the terminal against simulated data so your plugin's mock mode is exercised:

```sh
PROVIDERS=mock PLUGINS=./plugins/hello npm run dev
```

In unit tests, load the plugin the way the server does:

```ts
import { loadPlugins } from "../server/src/plugins/loader.js";
import { sanitizeSpec } from "../server/src/plugins/spec.js";

const reg = await loadPlugins(["./plugins/hello"], { mock: true, env: {}, log: () => {} }, { baseDir: repoRoot });
const spec = sanitizeSpec(await reg.functions.get("HELLO")!.fn.run({ security: null, option: 0, router, signal }));
const out = await reg.aiTools.find((t) => t.tool.spec.name === "hello_tool")!.tool.run({}, { router, signal });
```

For a complete example, see `server/src/plugins/plugins.test.ts`, which covers the EDGAR plugin in both mock and live-data modes.
