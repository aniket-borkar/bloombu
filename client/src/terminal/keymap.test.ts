import { describe, expect, it } from "vitest";
import { mapKey, sectorKeyText } from "./keymap";

describe("mapKey", () => {
  it("maps GO, CANCEL and HELP", () => {
    expect(mapKey({ key: "Enter" }, false)).toEqual({ type: "GO" });
    expect(mapKey({ key: "Escape" }, false)).toEqual({ type: "CANCEL" });
    expect(mapKey({ key: "F1" }, true)).toEqual({ type: "HELP" });
  });

  it.each([
    ["F2", "Govt"],
    ["F3", "Corp"],
    ["F4", "Mtge"],
    ["F5", "M-Mkt"],
    ["F6", "Muni"],
    ["F7", "Pfd"],
    ["F8", "Equity"],
    ["F9", "Comdty"],
    ["F10", "Index"],
    ["F11", "Curncy"],
  ])("maps %s to the %s sector key", (key, sector) => {
    expect(mapKey({ key }, false)).toEqual({ type: "SECTOR", sector });
  });

  it("leaves F12 and modified F-keys alone", () => {
    expect(mapKey({ key: "F12" }, false)).toBeNull();
    expect(mapKey({ key: "F8", ctrlKey: true }, false)).toBeNull();
  });

  it("treats Backspace as MENU only on an empty command line", () => {
    expect(mapKey({ key: "Backspace" }, true)).toEqual({ type: "MENU" });
    expect(mapKey({ key: "Backspace" }, false)).toBeNull();
  });

  it("cycles panels with Tab and Ctrl+Tab", () => {
    expect(mapKey({ key: "Tab" }, true)).toEqual({ type: "NEXT_PANEL" });
    expect(mapKey({ key: "Tab", ctrlKey: true }, true)).toEqual({ type: "NEXT_PANEL" });
    expect(mapKey({ key: "Tab", shiftKey: true }, true)).toEqual({ type: "PREV_PANEL" });
  });

  it("pages with PageUp/PageDown", () => {
    expect(mapKey({ key: "PageDown" }, true)).toEqual({ type: "PAGE_FWD" });
    expect(mapKey({ key: "PageUp" }, true)).toEqual({ type: "PAGE_BACK" });
  });

  it("navigates history with Alt+Arrow", () => {
    expect(mapKey({ key: "ArrowLeft", altKey: true }, false)).toEqual({ type: "MENU" });
    expect(mapKey({ key: "ArrowRight", altKey: true }, false)).toEqual({ type: "FORWARD" });
    expect(mapKey({ key: "ArrowLeft" }, false)).toBeNull();
  });

  it("ignores ordinary characters and Cmd shortcuts", () => {
    expect(mapKey({ key: "a" }, true)).toBeNull();
    expect(mapKey({ key: "Enter", metaKey: true }, true)).toBeNull();
  });
});

describe("sectorKeyText", () => {
  it("uses the key label", () => {
    expect(sectorKeyText("Equity")).toBe("<EQUITY>");
    expect(sectorKeyText("Comdty")).toBe("<CMDTY>");
    expect(sectorKeyText("Curncy")).toBe("<CRNCY>");
  });
});
