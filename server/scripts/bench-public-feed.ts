import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import WebSocket from "ws";
import { sourceTimeNs } from "../dist/sourceTime.js";

/**
 * Warm public-feed connection RTT, not exchange-to-screen market-data latency.
 * Sends only the documented, unauthenticated Kraken v2 JSON ping RPC:
 * https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/ping
 * No data subscription, API credential, account, or trading endpoint is used.
 */
const ENDPOINT = "wss://ws.kraken.com/v2";
const INTERVAL_MS = 250;
const TIMEOUT_MS = 5_000;
const WARMUP = 2;
const SAMPLES = 10;

interface Pong {
  method: "pong";
  req_id: number;
  success?: boolean;
  error?: string;
  time_in?: string;
  time_out?: string;
}
interface Observation { rttMs: number; remoteProcessingMs: number | null }
interface Pending {
  start: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (observation: Observation) => void;
  reject: (error: Error) => void;
}

const pending = new Map<number, Pending>();
const socket = new WebSocket(ENDPOINT, { handshakeTimeout: TIMEOUT_MS });
let sequence = 0;

function fail(id: number, error: Error): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.reject(error);
}

socket.on("error", (error) => {
  for (const id of pending.keys()) fail(id, error);
});
socket.on("close", () => {
  for (const id of pending.keys()) fail(id, new Error("Public feed connection closed"));
});
socket.on("message", (raw) => {
  const received = performance.now();
  let message: Pong;
  try { message = JSON.parse(raw.toString()) as Pong; } catch { return; }
  if (message.method !== "pong" || !Number.isInteger(message.req_id)) return;
  const entry = pending.get(message.req_id);
  if (!entry) return;
  if (message.success === false || message.error) {
    fail(message.req_id, new Error("Public feed rejected ping"));
    return;
  }
  pending.delete(message.req_id);
  clearTimeout(entry.timer);
  const timeIn = sourceTimeNs(message.time_in);
  const timeOut = sourceTimeNs(message.time_out);
  entry.resolve({
    rttMs: received - entry.start,
    remoteProcessingMs: timeIn !== null && timeOut !== null && timeOut >= timeIn ? Number(timeOut - timeIn) / 1_000_000 : null,
  });
});

function ping(): Promise<Observation> {
  if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Public feed is not connected"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => fail(id, new Error("Ping timed out after 5000ms")), TIMEOUT_MS);
    pending.set(id, { start: performance.now(), timer, resolve, reject });
    socket.send(JSON.stringify({ method: "ping", req_id: id }), (error) => { if (error) fail(id, error); });
  });
}

function summary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const percentile = (fraction: number) => round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]);
  return { samples: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: round(sorted.at(-1)!) };
}

const observations: Observation[] = [];
const errors: { phase: "warmup" | "sample"; sample: number; message: string }[] = [];
try {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("Connection closed before opening")));
  });
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const phase = i < WARMUP ? "warmup" : "sample";
    try {
      const observation = await ping();
      if (phase === "sample") observations.push(observation);
    } catch (error) {
      errors.push({ phase, sample: i < WARMUP ? i + 1 : i - WARMUP + 1, message: (error as Error).message });
      if (socket.readyState !== WebSocket.OPEN) break;
    }
    if (i + 1 < WARMUP + SAMPLES) await pause(INTERVAL_MS);
  }
} catch (error) {
  errors.push({ phase: "warmup", sample: 0, message: (error as Error).message });
} finally {
  if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  else if (socket.readyState === WebSocket.OPEN) socket.close();
}

process.stdout.write(`${JSON.stringify({
  benchmark: "public-feed-ping-rtt",
  endpoint: ENDPOINT,
  scope: "Warmed application-level JSON ping/pong RTT from this machine to Kraken and back; not one-way market-data delivery or exchange-to-browser paint",
  clock: "performance.now() (local monotonic), milliseconds",
  remoteTimingScope: "Optional provider-reported time_out minus time_in; no cross-machine clock subtraction",
  timestampUtc: new Date().toISOString(),
  runtime: process.version,
  warmupRequests: WARMUP, requestedSamples: SAMPLES,
  minimumSpacingMs: INTERVAL_MS, requestTimeoutMs: TIMEOUT_MS,
  rtt: summary(observations.map((o) => o.rttMs)),
  remoteProcessing: summary(observations.flatMap((o) => o.remoteProcessingMs === null ? [] : [o.remoteProcessingMs])),
  errors,
}, null, 2)}\n`);
if (observations.length !== SAMPLES || errors.length) process.exitCode = 1;
