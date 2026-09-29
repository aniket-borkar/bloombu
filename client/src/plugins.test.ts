import { describe, expect, it, vi } from "vitest";
import { registerPluginFunctions } from "./plugins";
import { SCREEN_REGISTRY } from "./screens";
import { PluginScreen, formatCell } from "./screens/PluginScreen";
import { parseCommand } from "./terminal/commandParser";
import { FUNCTION_LIST, FUNCTIONS, SECURITY_MENUS } from "./terminal/functions";

describe("registerPluginFunctions", () => {
  it("adds plugin functions everywhere the terminal looks up functions", () => {
    const warn = vi.fn();
    const added = registerPluginFunctions(
      [
        { code: "CF", name: "Company Filings", security: true, sectors: ["Equity"], options: ["All"], plugin: "edgar" },
        { code: "MKTX", name: "Market Thing", security: false, sectors: null, options: [], plugin: "demo" },
        { code: "DES", name: "Hijack", security: true, sectors: null, options: [], plugin: "evil" },
      ],
      warn,
    );
    expect(added).toEqual(["CF", "MKTX"]);
    expect(warn).toHaveBeenCalledWith('Plugin function DES from "evil" skipped: the terminal already has DES');
    expect(FUNCTIONS.CF).toEqual({ code: "CF", name: "Company Filings", security: true });
    expect(FUNCTIONS.DES.name).toBe("Description");
    expect(SCREEN_REGISTRY.CF).toEqual({ component: PluginScreen, sectors: ["Equity"] });
    expect(SECURITY_MENUS.Equity.at(-1)).toBe("CF");
    expect(SECURITY_MENUS.Index).not.toContain("CF");
    expect(FUNCTION_LIST.at(-1)!.code).toBe("HELP");
    expect(parseCommand("AAPL US EQUITY CF")).toEqual({ kind: "load", security: "AAPL US Equity", fn: "CF" });
    expect(parseCommand("MKTX")).toEqual({ kind: "function", fn: "MKTX" });
    expect(registerPluginFunctions([{ code: "CF", name: "Again", security: true, sectors: ["Equity"], options: [], plugin: "edgar" }])).toEqual([]);
    expect(SECURITY_MENUS.Equity.filter((c) => c === "CF")).toHaveLength(1);
  });
});

describe("formatCell", () => {
  it("formats plugin table cells by column format", () => {
    expect(formatCell(null)).toBe("--");
    expect(formatCell("2026-09-24", { key: "d", label: "D", format: "date" })).toBe("09/24/26");
    expect(formatCell(1234.567, { key: "n", label: "N", format: "number", decimals: 1 })).toBe("1,234.6");
    expect(formatCell(12.345, { key: "p", label: "P", format: "pct" })).toBe("12.35%");
    expect(formatCell(42)).toBe("42");
    expect(formatCell("text")).toBe("text");
  });
});
