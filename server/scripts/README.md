# Quote latency benchmarks

Build the server from the repository root:

```powershell
npm run build -w server
```

Measure CPU dispatch through the built quote hub:

```powershell
node --experimental-strip-types server/scripts/bench-quotes.ts --samples 10000 --warmup 2000
```

This uses synthetic quotes and queued fake clients. It includes source timestamp
ordering, change detection, JSON serialization, recipient lookup and fake enqueueing.
It excludes exchange delivery, network transport, socket/TLS encoding, and browser
paint. Results include p50, p95, p99 and maximum, in microseconds, for different
subscriber and idle-client counts. There are no timing pass/fail thresholds.

Measure a live public-feed connection:

```powershell
node --experimental-strip-types server/scripts/bench-public-feed.ts
```

This sends two warmup and ten measured JSON ping requests to Kraken's public
WebSocket v2 endpoint. It needs no account or API key, subscribes to no data, and
uses no trading endpoints. Requests are spaced at least 250 ms apart and each
times out after five seconds. The RPC schema is documented in
[Kraken's ping reference](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ping).

The live benchmark reports round-trip p50, p95, p99 and maximum in milliseconds.
Optional remote processing is calculated only from the provider's two timestamps.
Round-trip time is not one-way quote delivery, source quote age, or
exchange-to-browser paint latency; dividing it by two does not establish those
quantities. Ten samples describe this short run, not a latency guarantee. With ten
samples the reported nearest-rank p95 and p99 both equal the largest observation.
