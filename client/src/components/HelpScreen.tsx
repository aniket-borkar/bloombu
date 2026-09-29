import { useEffect } from "react";
import { isUnavailable } from "../screens";
import { usePanels, type PanelState } from "../store/panels";
import { FUNCTION_LIST } from "../terminal/functions";
import { PLUGIN_FUNCTIONS } from "../terminal/pluginFunctions";
import { SECTOR_KEYS } from "../terminal/sectors";

const KEYS: [string, string][] = [
  ["Enter", "<GO>: execute the command line"],
  ["Esc", "<CANCEL>: clear the command line (in a form field: back to the command line)"],
  ["F1", "<HELP>: this screen"],
  ["Backspace", "<MENU>: back to the previous screen (when the command line is empty)"],
  ["Alt+Left / Alt+Right", "Back / forward through this panel's history"],
  ["Tab / Shift+Tab", "Move to the next / previous panel"],
  ["PgDn / PgUp", "<PAGE FWD> / <PAGE BACK>"],
  ...SECTOR_KEYS.map((k): [string, string] => [k.fkey, `<${k.key}> yellow key: ${k.sector} market sector`]),
];

const SYNTAX: [string, string][] = [
  ["AAPL US <EQUITY> <GO>", "Load a security. Equity = ticker + exchange code + yellow key"],
  ["AAPL US <EQUITY> DES <GO>", "Load a security and run a function"],
  ["DES <GO>", "Run a function on the loaded security"],
  ["WEI <GO>", "Run a market-level function"],
  ["3 <GO>", "Pick item 3 from a numbered menu or option bar"],
  ["? question <GO>", "Ask the AI analyst, e.g. ? compare AAPL and MSFT margins"],
  ["SPX <INDEX>", "Indices: SPX INDU CCMP NDX RTY VIX UKX DAX CAC SX5E NKY HSI AS51 USGG10YR"],
  ["EURUSD <CRNCY>", "FX pairs, or single codes: EUR JPY GBP. Crypto: XBTUSD XETUSD"],
  ["CL1 <CMDTY>", "Generic futures: CL1 CO1 NG1 GC1 SI1 HG1 C 1 W 1 S 1 ES1 NQ1 TY1; months: CLZ6"],
  ["CT10 <GOVT>", "US Treasury actives: CT3M CT5 CT10 CT30"],
  ["Exchange codes", "US LN GY FP NA SM IM SW JT HK AU CN KS TT IN SP BZ MM"],
];

const TITLES = ["Keyboard", "Command syntax", "Functions (1/2)", "Functions (2/2)"];

export function HelpScreen({ panel }: { panel: PanelState }) {
  const { setPageCount } = usePanels.getState();

  useEffect(() => {
    setPageCount(panel.id, TITLES.length);
  }, [panel.id, setPageCount]);

  const rows = panel.page === 0 ? KEYS : panel.page === 1 ? SYNTAX : null;
  const half = Math.ceil(FUNCTION_LIST.length / 2);
  const functions = panel.page === 2 ? FUNCTION_LIST.slice(0, half) : FUNCTION_LIST.slice(half);

  return (
    <div data-testid="help-screen">
      <div className="menu-title">
        HELP &lt;GO&gt; {TITLES[panel.page]}
        <span className="gray">
          {" "}
          (Page {panel.page + 1}/{TITLES.length}, PgDn/PgUp)
        </span>
      </div>
      {rows ? (
        <table className="help-table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="menu">
          {functions.map((f) => (
            <div key={f.code} className="menu-item">
              <span className="menu-code">{f.code}</span>
              <span className="menu-label">{f.name}</span>
              {isUnavailable(f.code) && <span className="gray">(no free data)</span>}
              {PLUGIN_FUNCTIONS.has(f.code) && <span className="gray">(plugin: {PLUGIN_FUNCTIONS.get(f.code)!.plugin})</span>}
              {f.code === "ECO" && <span className="gray">(FRED key)</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
