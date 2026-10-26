import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { LAYOUTS, LINK_COLORS, usePanels, type PanelState } from "../store/panels";
import { downloadResearch } from "../terminal/researchState";

const MENUS = ["Actions", "Output", "Settings"] as const;
type MenuName = (typeof MENUS)[number];

export function PanelMenus({ panel, focused, onPopOut }: {
  panel: PanelState;
  focused: boolean;
  onPopOut: () => void;
}) {
  const layout = usePanels((s) => s.layout);
  const [active, setActive] = useState<MenuName | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastItem = useRef(false);
  const trigger = (name: MenuName) => barRef.current?.querySelector<HTMLButtonElement>(`[data-menu="${name}"]`);
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
  const menuId = `panel-${panel.id}-menu`;

  useEffect(() => { if (!focused) setActive(null); }, [focused]);
  useEffect(() => { setActive(null); setFeedback(null); }, [panel.screen.security, panel.screen.fn]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useLayoutEffect(() => {
    if (!active) return;
    const place = () => {
      const button = trigger(active);
      const menu = menuRef.current;
      if (!button || !menu) return;
      const rect = button.getBoundingClientRect();
      const { width, height } = menu.getBoundingClientRect();
      const below = rect.bottom + 2;
      const top = below + height <= window.innerHeight - 8 ? below : rect.top - height - 2;
      setPosition({
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    };
    place();
    const choices = items();
    (lastItem.current ? choices.at(-1) : choices[0])?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!barRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setActive(null);
        const control = target instanceof Element && target.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable]");
        if (!control) usePanels.getState().refocus();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    // Capturing scroll also keeps the menu attached when a surrounding region moves.
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active]);

  const open = (name: MenuName, last = false) => {
    usePanels.getState().focus(panel.id);
    lastItem.current = last;
    setFeedback(null);
    setActive(name);
  };
  const dismiss = () => {
    if (active) trigger(active)?.focus();
    setActive(null);
  };
  const run = (action: () => void) => {
    setActive(null);
    action();
    usePanels.getState().refocus();
  };
  const navigate = (fn: string) => run(() => usePanels.getState().execute(panel.id, { kind: "function", fn }));
  const onKeyDown = (e: KeyboardEvent) => {
    // Native button activation must not also execute a terminal command.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "Tab") {
      // Portalled menu items are outside the panel's tab order.
      e.preventDefault();
      const next = MENUS.indexOf(active!) + (e.shiftKey ? -1 : 1);
      setActive(null);
      if (next >= 0 && next < MENUS.length) trigger(MENUS[next])?.focus();
      else usePanels.getState().refocus();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const choices = items();
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1
        : (index + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[next]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      open(MENUS[(MENUS.indexOf(active!) + (e.key === "ArrowRight" ? 1 : -1) + MENUS.length) % MENUS.length]);
    }
  };
  const onBlur = (target: EventTarget | null) => {
    if (!(target instanceof Node) || (!barRef.current?.contains(target) && !menuRef.current?.contains(target))) setActive(null);
  };

  const screenText = () => {
    const screen = barRef.current?.closest(".panel")?.querySelector<HTMLElement>(".screen");
    if (!screen) throw new Error("Screen is unavailable.");
    const fields = [...screen.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input:not([type=hidden]):not([type=password]), textarea, select")]
      .filter((field) => field.getClientRects().length > 0)
      .map((field) => {
        const label = field.labels?.[0]?.innerText || field.getAttribute("aria-label") || field.getAttribute("placeholder") || field.name || "Value";
        const value = field instanceof HTMLInputElement && ["checkbox", "radio"].includes(field.type) ? String(field.checked) : field.value;
        return `${label}: ${value}`;
      });
    return [`BLMBU — Panel ${panel.id}`, [panel.screen.security, panel.screen.fn].filter(Boolean).join(" ") || "Home",
      `Current screen · page ${panel.page + 1}/${panel.pageCount} · ${new Date().toISOString()}`, "", screen.innerText,
      ...(fields.length ? ["", "Form values", ...fields] : [])].join("\n");
  };
  const copy = () => {
    let text: string;
    try { text = screenText(); } catch { setFeedback({ text: "Screen is unavailable.", error: true }); return; }
    run(() => {
      if (!navigator.clipboard?.writeText) {
        setFeedback({ text: "Clipboard is unavailable. Use Download current screen instead.", error: true });
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => setFeedback({ text: "Current screen copied.", error: false }),
        () => setFeedback({ text: "Clipboard permission was denied. Use Download current screen instead.", error: true }),
      );
    });
  };
  const download = () => run(() => {
    try {
      const name = ["blmbu", `panel-${panel.id}`, panel.screen.security, panel.screen.fn].filter(Boolean).join("-");
      downloadResearch(`${name}.txt`, screenText(), "text/plain;charset=utf-8");
      setFeedback({ text: "Current screen downloaded.", error: false });
    } catch { setFeedback({ text: "Download failed. Try Copy current screen instead.", error: true }); }
  });

  return (
    <div className="action-bar" ref={barRef} data-panel-menu onBlur={(e) => onBlur(e.relatedTarget)}>
      {MENUS.map((name, i) => (
        <button key={name} type="button" className="action panel-menu-trigger" data-menu={name}
          aria-label={name} aria-haspopup="menu" aria-expanded={active === name} aria-controls={active === name ? menuId : undefined}
          onClick={() => active === name ? dismiss() : open(name)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(name, e.key === "ArrowUp"); }
            else if (e.key === "Escape") { e.preventDefault(); dismiss(); }
          }}>
          <span className="action-num">{96 + i})</span> {name} ▾
        </button>
      ))}
      <span className="spacer" />
      {panel.pageCount > 1 && <span className="action">Page {panel.page + 1}/{panel.pageCount}</span>}
      {feedback && <span className={`panel-menu-feedback${feedback.error ? " error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</span>}
      {active && createPortal(
        <div ref={menuRef} id={menuId} className="panel-dropdown" role="menu" aria-label={`${active} panel ${panel.id}`}
          data-panel-menu style={position} onKeyDown={onKeyDown} onBlur={(e) => onBlur(e.relatedTarget)}>
          {active === "Actions" && <>
            <button role="menuitem" disabled={!panel.back.length} onClick={() => run(() => usePanels.getState().menu(panel.id))}>Back</button>
            <button role="menuitem" disabled={!panel.forward.length} onClick={() => run(() => usePanels.getState().forward(panel.id))}>Forward</button>
            <button role="menuitem" disabled={!panel.screen.security} onClick={() => run(() => usePanels.getState().execute(panel.id, { kind: "load", security: panel.screen.security!, fn: null }))}>Security menu</button>
            <button role="menuitem" onClick={() => run(() => usePanels.getState().help(panel.id))}>Help</button>
            <button role="menuitem" onClick={() => run(onPopOut)}>Pop out</button>
          </>}
          {active === "Output" && <>
            <button role="menuitem" onClick={copy}>Copy current screen</button>
            <button role="menuitem" onClick={download}>Download current screen (.txt)</button>
            <p className="panel-menu-note">Text from this screen and page. Charts are not included.</p>
          </>}
          {active === "Settings" && <>
            <div role="group" aria-label="Workspace layout">
              <div className="panel-menu-heading">Workspace layout</div>
              {LAYOUTS.map((n) => <button key={n} role="menuitemradio" aria-label={`${n} panel${n === 1 ? "" : "s"}`} aria-checked={layout === n}
                onClick={() => run(() => usePanels.getState().setLayout(n))}>{n} panel{n === 1 ? "" : "s"}</button>)}
            </div>
            <div role="group" aria-label="Panel link group">
              <div className="panel-menu-heading">Panel link group</div>
              {([null, ...LINK_COLORS] as const).map((color) => <button key={color ?? "none"} role="menuitemradio"
                aria-label={color ? `${color[0].toUpperCase()}${color.slice(1)} link group` : "No link group"} aria-checked={panel.link === color}
                onClick={() => run(() => usePanels.getState().setLink(panel.id, color))}>
                {color ? `${color[0].toUpperCase()}${color.slice(1)} link group` : "No link group"}
              </button>)}
            </div>
            <button role="menuitem" onClick={() => navigate("LAYOUT")}>Saved workspaces</button>
            <button role="menuitem" onClick={() => navigate("SRC")}>Data sources</button>
          </>}
        </div>, document.body,
      )}
    </div>
  );
}
