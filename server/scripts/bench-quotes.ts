import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { StreamHub } from "../dist/stream/hub.js";
import type { StreamClient } from "../src/stream/hub.js";
import type { ProviderPlugin } from "../src/providers/DataProvider.js";
import type { Quote } from "../src/types.js";

/**
 * CPU benchmark of the built quote hub, not exchange/network/browser latency.
 * Build the server first, then run with Node's --experimental-strip-types flag.
 * Timing includes timestamp ordering,
 * change detection, JSON serialization, recipient lookup, and enqueueing the
 * serialized message into fake clients. Queue draining and fixture creation are
 * outside the measured interval. No socket, TLS, compression, or paint is used.
 */
function countArg(name: string, fallback: number, minimum: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > 1_000_000) {
    throw new Error(`${name} must be an integer between ${minimum} and 1000000`);
  }
  return value;
}

const samples = countArg("--samples", 10_000, 1);
const warmup = countArg("--warmup", 2_000, 0);
const security = "XBTUSD Curncy";
const template: Quote = {
  security, name: "Bitcoin USD", last: 80_000, change: 100, changePct: 0.125,
  bid: 79_999, ask: 80_001, bidSize: 0.5, askSize: 0.7,
  open: null, high: 81_000, low: 78_000, prevClose: 79_900, volume: 1234,
  currency: "USD", exchange: "Synthetic", marketState: "REGULAR",
  time: "2026-10-26T12:00:00.100000000Z", delayMinutes: 0, source: "Synthetic benchmark",
};

const workloads = [
  { subscribers: 1, idleClients: 0 },
  { subscribers: 10, idleClients: 0 },
  { subscribers: 100, idleClients: 0 },
  { subscribers: 1, idleClients: 1000 },
  { subscribers: 10, idleClients: 1000 },
  { subscribers: 100, idleClients: 1000 },
];

function run({ subscribers, idleClients }: (typeof workloads)[number]) {
  let push!: (quote: Quote) => void;
  const queue: string[] = [];
  const plugin: ProviderPlugin = {
    id: "synthetic-native", sectors: ["Curncy"],
    subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
  };
  const hub = new StreamHub({ quotes: async () => [], streamingPlugin: () => plugin }, 5000, () => {});
  try {
    for (let i = 0; i < subscribers + idleClients; i++) {
      const client: StreamClient = { send: (data) => { queue.push(data); } };
      hub.connect(client);
      if (i < subscribers) hub.handleMessage(client, JSON.stringify({ op: "sub", securities: [security] }));
    }
    const timings: number[] = [];
    const wallStart = performance.now();
    for (let i = 0; i < warmup + samples; i++) {
      const quote = {
        ...template, last: 80_000 + i / 100,
        time: `2026-10-26T12:00:00.${String(100_000_000 + i).padStart(9, "0")}Z`,
      };
      const start = performance.now();
      push(quote);
      const microseconds = (performance.now() - start) * 1000;
      if (queue.length !== subscribers) throw new Error(`Expected ${subscribers} queued recipients, received ${queue.length}`);
      queue.length = 0;
      if (i >= warmup) timings.push(microseconds);
    }
    const wallMs = performance.now() - wallStart;
    timings.sort((a, b) => a - b);
    const percentile = (fraction: number) => timings[Math.min(timings.length - 1, Math.ceil(timings.length * fraction) - 1)];
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
      subscribers, idleClients, samples, warmup,
      p50Us: round(percentile(0.5)), p95Us: round(percentile(0.95)),
      p99Us: round(percentile(0.99)), maxUs: round(timings.at(-1)!),
      fixtureAndMeasuredLoopMs: round(wallMs),
    };
  } finally { hub.close(); }
}

process.stdout.write(`${JSON.stringify({
  benchmark: "quote-hub-dispatch",
  scope: "CPU only: native callback through the built hub to queued fake sends; excludes exchange, network, socket encoding, and browser paint",
  entrypoint: "server/dist/stream/hub.js",
  runtime: process.version, platform: process.platform,
  cpu: cpus()[0]?.model ?? "unknown",
  clock: "performance.now() (monotonic); values in microseconds",
  results: workloads.map(run),
}, null, 2)}\n`);
