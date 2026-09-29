import { dispatch } from "../terminal/dispatch";
import type { KeyAction } from "../terminal/keymap";
import { SECTOR_KEYS } from "../terminal/sectors";

interface KeyDef {
  label: string;
  hint: string;
  kind: "sector" | "action" | "cancel";
  action: KeyAction;
}

const KEYS: KeyDef[] = [
  { label: "CANCEL", hint: "Esc", kind: "cancel", action: { type: "CANCEL" } },
  ...SECTOR_KEYS.map((k): KeyDef => ({
    label: k.key,
    hint: k.fkey,
    kind: "sector",
    action: { type: "SECTOR", sector: k.sector },
  })),
  { label: "HELP", hint: "F1", kind: "action", action: { type: "HELP" } },
  { label: "MENU", hint: "Bksp", kind: "action", action: { type: "MENU" } },
  { label: "PG BACK", hint: "PgUp", kind: "action", action: { type: "PAGE_BACK" } },
  { label: "PG FWD", hint: "PgDn", kind: "action", action: { type: "PAGE_FWD" } },
  { label: "PANEL", hint: "Tab", kind: "action", action: { type: "NEXT_PANEL" } },
  { label: "GO", hint: "Enter", kind: "action", action: { type: "GO" } },
];

export function KeyLegend() {
  return (
    <div className="key-legend">
      {KEYS.map((k) => (
        <button
          key={k.label}
          className={`key ${k.kind}`}
          title={`${k.label} (${k.hint})`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => dispatch(k.action)}
        >
          <small>{k.hint}</small>
          {k.label}
        </button>
      ))}
    </div>
  );
}
