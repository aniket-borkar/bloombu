import { beforeEach, describe, expect, it } from "vitest";
import { usePanels } from "./panels";

const panel = (id: number) => usePanels.getState().panels.find((p) => p.id === id)!;
const s = () => usePanels.getState();

describe("panel store", () => {
  beforeEach(() => {
    usePanels.setState(usePanels.getInitialState(), true);
  });

  it("loads a security from typed input and sector key", () => {
    s().setInput(1, "aapl us");
    s().insertSector(1, "Equity");
    expect(panel(1).input).toBe("AAPL US <EQUITY> ");
    s().go(1);
    expect(panel(1).screen).toEqual({ security: "AAPL US Equity", fn: null });
    expect(panel(1).input).toBe("");
  });

  it("selects numbered menu items and goes back with MENU", () => {
    s().setInput(1, "SPX INDEX");
    s().go(1);
    s().setInput(1, "1");
    s().go(1);
    expect(panel(1).screen).toEqual({ security: "SPX Index", fn: "DES" });
    s().menu(1);
    expect(panel(1).screen).toEqual({ security: "SPX Index", fn: null });
    s().forward(1);
    expect(panel(1).screen.fn).toBe("DES");
  });

  it("selects screen options with numbers and resets them on navigation", () => {
    s().setInput(1, "AAPL US EQUITY GP");
    s().go(1);
    expect(panel(1).screen).toEqual({ security: "AAPL US Equity", fn: "GP" });
    expect(panel(1).option).toBeNull();
    s().setOptionCount(1, 7);
    s().setInput(1, "3");
    s().go(1);
    expect(panel(1).option).toBe(2);
    expect(panel(1).screen.fn).toBe("GP");
    s().setInput(1, "9");
    s().go(1);
    expect(panel(1).option).toBe(2);
    expect(panel(1).message).toMatch(/NO OPTION 9/);
    s().menu(1);
    s().forward(1);
    expect(panel(1).option).toBeNull();
    expect(panel(1).optionCount).toBe(0);
  });

  it("changes layouts and keeps focus on a visible panel", () => {
    s().focus(4);
    s().setLayout(2);
    expect(s().focused).toBe(1);
    s().focusNext(1);
    s().focusNext(1);
    expect(s().focused).toBe(1);
    s().setLayout(9);
    s().focus(9);
    expect(s().focused).toBe(9);
    expect(s().panels).toHaveLength(9);
  });

  it("links panels so security changes follow, keeping each panel's function", () => {
    s().setInput(1, "AAPL US EQUITY DES");
    s().go(1);
    s().setInput(2, "AAPL US EQUITY GP");
    s().go(2);
    s().setInput(3, "WEI");
    s().go(3);
    s().cycleLink(1);
    s().cycleLink(2);
    s().cycleLink(3);
    expect(panel(1).link).toBe("amber");
    s().setInput(1, "MSFT US EQUITY DES");
    s().go(1);
    expect(panel(2).screen).toEqual({ security: "MSFT US Equity", fn: "GP" });
    expect(panel(3).screen.fn).toBe("WEI");
    s().cycleLink(2);
    s().setInput(1, "IBM US EQUITY");
    s().go(1);
    expect(panel(2).screen.security).toBe("MSFT US Equity");
    for (const color of ["green", "blue", "red", null]) {
      s().cycleLink(1);
      expect(panel(1).link).toBe(color);
    }
  });

  it("snapshots and restores workspaces", () => {
    s().setLayout(6);
    s().setInput(5, "SPX INDEX GP");
    s().go(5);
    s().cycleLink(5);
    const w = s().snapshot();
    expect(w.layout).toBe(6);
    expect(w.panels).toHaveLength(6);
    usePanels.setState(usePanels.getInitialState(), true);
    s().restore(w);
    expect(s().layout).toBe(6);
    expect(panel(5).screen).toEqual({ security: "SPX Index", fn: "GP" });
    expect(panel(5).link).toBe("amber");
    s().restore({ layout: 7 as never, panels: [{ screen: null as never, link: "pink" as never }] });
    expect(s().layout).toBe(4);
    expect(panel(1).screen).toEqual({ security: null, fn: null });
    expect(panel(1).link).toBeNull();
  });

  it("sanitizes the login name for chat", () => {
    s().login("  jane doe!  ");
    expect(s().user).toBe("JANE_DOE_");
    s().login("");
    expect(s().user).toBe("GUEST");
  });

  it("rejects security functions with no security loaded", () => {
    s().setInput(2, "DES");
    s().go(2);
    expect(panel(2).screen.fn).toBeNull();
    expect(panel(2).message).toMatch(/REQUIRES A SECURITY/);
  });

  it("keeps panels independent", () => {
    s().setInput(1, "IBM US EQUITY");
    s().go(1);
    expect(panel(2).screen.security).toBeNull();
  });

  it("cycles focus in both directions", () => {
    s().focusNext(-1);
    expect(s().focused).toBe(4);
    s().focusNext(1);
    s().focusNext(1);
    expect(s().focused).toBe(2);
  });

  it("clamps paging to the page count", () => {
    s().setPageCount(1, 2);
    s().page(1, 1);
    s().page(1, 1);
    expect(panel(1).page).toBe(1);
    s().page(1, -1);
    s().page(1, -1);
    expect(panel(1).page).toBe(0);
  });
});
