import { usePanels } from "../store/panels";
import type { KeyAction } from "./keymap";

/** Apply a terminal key action to the focused panel. */
export function dispatch(action: KeyAction): void {
  const s = usePanels.getState();
  const id = s.focused;
  switch (action.type) {
    case "GO":
      return s.go(id);
    case "CANCEL":
      return s.cancel(id);
    case "HELP":
      return s.help(id);
    case "MENU":
      return s.menu(id);
    case "FORWARD":
      return s.forward(id);
    case "SECTOR":
      return s.insertSector(id, action.sector);
    case "NEXT_PANEL":
      return s.focusNext(1);
    case "PREV_PANEL":
      return s.focusNext(-1);
    case "PAGE_FWD":
      return s.page(id, 1);
    case "PAGE_BACK":
      return s.page(id, -1);
  }
}
