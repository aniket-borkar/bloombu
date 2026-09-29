import { describe, expect, it } from "vitest";
import { onPendingBacktest, setPendingBacktest, takePendingBacktest, type PendingBacktest } from "./backtestState";

const golden: PendingBacktest = { entry: "crossAbove(sma(close, 50), sma(close, 200))", exit: "", direction: "long", costBps: 5, range: "5y" };
const spy = { panelId: 2, security: "SPY US Equity" };

describe("backtest handoff", () => {
  it("waits for the next BTST screen for that panel and security", () => {
    setPendingBacktest(spy, golden);
    expect(takePendingBacktest({ panelId: 3, security: "SPY US Equity" })).toBeNull();
    expect(takePendingBacktest({ panelId: 2, security: "QQQ US Equity" })).toBeNull();
    expect(takePendingBacktest(spy)).toEqual(golden);
    expect(takePendingBacktest(spy)).toBeNull();
  });

  it("goes straight to a mounted screen showing the same security", () => {
    const got: PendingBacktest[] = [];
    const other: PendingBacktest[] = [];
    const off = onPendingBacktest(spy, (p) => got.push(p));
    const offOther = onPendingBacktest({ panelId: 2, security: "QQQ US Equity" }, (p) => other.push(p));
    setPendingBacktest(spy, golden);
    expect(got).toEqual([golden]);
    expect(other).toEqual([]);
    expect(takePendingBacktest(spy)).toBeNull();
    off();
    offOther();
    setPendingBacktest(spy, golden);
    expect(got).toHaveLength(1);
    expect(takePendingBacktest(spy)).toEqual(golden);
  });
});
