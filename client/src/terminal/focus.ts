/** True for fields inside screens (calculators, chat, grids), which own their keystrokes. */
export function isFormField(el: EventTarget | Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.cmdline) return false;
  if (el.closest("[data-grid]")) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}
