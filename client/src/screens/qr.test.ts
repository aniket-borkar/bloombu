import { describe, expect, it } from "vitest";
import { sizeText, tapeStats } from "./QrScreen";

describe("tapeStats", () => {
  it("computes volume, VWAP, aggressor split and range from a trade tape", () => {
    const s = tapeStats([
      { time: "t1", price: 100, size: 2, side: "buy", venue: null },
      { time: "t2", price: 101, size: 1, side: "sell", venue: null },
      { time: "t3", price: 99, size: null, side: null, venue: null },
    ]);
    expect(s).toEqual({ count: 3, volume: 3, vwap: (200 + 101) / 3, buyVolume: 2, sellVolume: 1, high: 101, low: 99 });
    expect(tapeStats([])).toEqual({ count: 0, volume: 0, vwap: null, buyVolume: 0, sellVolume: 0, high: null, low: null });
  });

  it("shows satoshi-sized crypto trades", () => {
    expect(sizeText(0.00002345)).toBe("0.00002345");
    expect(sizeText(0.5)).toBe("0.5000");
    expect(sizeText(300)).toBe("300");
    expect(sizeText(null)).toBe("--");
  });
});
