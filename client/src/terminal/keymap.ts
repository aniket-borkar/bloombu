import { SECTOR_KEYS, type Sector } from "./sectors";

export type KeyAction =
  | { type: "GO" }
  | { type: "CANCEL" }
  | { type: "HELP" }
  | { type: "MENU" }
  | { type: "FORWARD" }
  | { type: "SECTOR"; sector: Sector }
  | { type: "NEXT_PANEL" }
  | { type: "PREV_PANEL" }
  | { type: "PAGE_FWD" }
  | { type: "PAGE_BACK" };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

const SECTOR_BY_FKEY = Object.fromEntries(SECTOR_KEYS.map((k) => [k.fkey, k.sector])) as Record<string, Sector>;

/**
 * Map a physical key press to a terminal action. `inputEmpty` reflects the
 * command line, since Backspace only acts as MENU when there is nothing to delete.
 */
export function mapKey(e: KeyInput, inputEmpty: boolean): KeyAction | null {
  if (e.metaKey) return null;
  switch (e.key) {
    case "Enter":
      return { type: "GO" };
    case "Escape":
      return { type: "CANCEL" };
    case "F1":
      return { type: "HELP" };
    case "Tab":
      return e.shiftKey ? { type: "PREV_PANEL" } : { type: "NEXT_PANEL" };
    case "PageDown":
      return { type: "PAGE_FWD" };
    case "PageUp":
      return { type: "PAGE_BACK" };
    case "Backspace":
      return inputEmpty && !e.ctrlKey && !e.altKey ? { type: "MENU" } : null;
    case "ArrowLeft":
      return e.altKey ? { type: "MENU" } : null;
    case "ArrowRight":
      return e.altKey ? { type: "FORWARD" } : null;
  }
  const sector = SECTOR_BY_FKEY[e.key];
  if (sector && !e.ctrlKey && !e.altKey) return { type: "SECTOR", sector };
  return null;
}

/** Text inserted on the command line when a yellow sector key is pressed. */
export function sectorKeyText(sector: Sector): string {
  return `<${SECTOR_KEYS.find((k) => k.sector === sector)!.key}>`;
}
