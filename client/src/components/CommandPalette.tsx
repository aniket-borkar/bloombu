import { useEffect, useMemo, useRef, useState } from "react";
import { api, searchSecurities, type SearchResult } from "../api";
import { LAYOUTS, usePanels } from "../store/panels";
import { FUNCTION_LIST } from "../terminal/functions";
import { rememberPortfolio } from "../terminal/portfolioState";
import { setPendingSheet } from "../terminal/sheetState";

interface Item {
  kind: "Function" | "Security" | "Portfolio" | "Sheet" | "Recent" | "Layout";
  label: string;
  detail: string;
  run: () => void;
}

/** Subsequence match score (lower is better); -1 when not a match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return idx;
  let pos = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, pos);
    if (found < 0) return -1;
    gaps += found - pos;
    pos = found + 1;
  }
  return 100 + gaps;
}

/** Ctrl/Cmd+K: jump to any function, security, portfolio, sheet, recent screen or layout. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const user = usePanels((s) => s.user);
  const focused = usePanels((s) => s.focused);
  const panels = usePanels((s) => s.panels);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [securities, setSecurities] = useState<SearchResult[]>([]);
  const [portfolios, setPortfolios] = useState<{ id: number; name: string }[]>([]);
  const [sheets, setSheets] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    api.portfolios(user).then(setPortfolios).catch(() => {});
    api.docs.list(user, "sheet").then((l) => setSheets(l.map((s) => s.name))).catch(() => {});
  }, [user]);

  useEffect(() => {
    setActive(0);
    if (query.trim().length < 2) {
      setSecurities([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchSecurities(query.trim(), ctrl.signal)
        .then((r) => setSecurities(r.slice(0, 6)))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const items = useMemo(() => {
    const s = usePanels.getState();
    const exec = (cmd: Parameters<typeof s.execute>[1]) => s.execute(focused, cmd);
    const all: (Item & { score: number })[] = [];
    const add = (item: Item, text: string) => {
      const score = fuzzyScore(query.trim(), text);
      if (score >= 0) all.push({ ...item, score });
    };
    for (const f of FUNCTION_LIST) add({ kind: "Function", label: f.code, detail: f.name, run: () => exec({ kind: "function", fn: f.code }) }, `${f.code} ${f.name}`);
    for (const r of securities) all.push({ kind: "Security", label: r.security, detail: r.name, run: () => exec({ kind: "load", security: r.security, fn: null }), score: 50 });
    for (const p of portfolios) {
      add(
        {
          kind: "Portfolio",
          label: p.name,
          detail: "open in PORT",
          run: () => {
            rememberPortfolio(user, p.id);
            exec({ kind: "function", fn: "PORT" });
          },
        },
        `portfolio ${p.name}`,
      );
    }
    for (const name of sheets) {
      add(
        {
          kind: "Sheet",
          label: name,
          detail: "open in SHEET",
          run: () => {
            setPendingSheet(name);
            exec({ kind: "function", fn: "SHEET" });
          },
        },
        `sheet ${name}`,
      );
    }
    const seen = new Set<string>();
    for (const p of panels) {
      for (const sc of [...p.back].reverse()) {
        if (!sc.security && !sc.fn) continue;
        const label = [sc.security, sc.fn].filter(Boolean).join(" ");
        if (seen.has(label)) continue;
        seen.add(label);
        add(
          {
            kind: "Recent",
            label,
            detail: "recent screen",
            run: () => (sc.security ? exec({ kind: "load", security: sc.security, fn: sc.fn }) : exec({ kind: "function", fn: sc.fn! })),
          },
          label,
        );
      }
    }
    for (const n of LAYOUTS) add({ kind: "Layout", label: `${n} panel${n > 1 ? "s" : ""}`, detail: "layout", run: () => s.setLayout(n) }, `layout ${n} panels`);
    return all.sort((a, b) => a.score - b.score).slice(0, 12);
  }, [query, securities, portfolios, sheets, panels, focused, user]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" data-testid="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="form-input palette-input"
          placeholder="Search functions, securities, portfolios, sheets, layouts..."
          value={query}
          data-testid="palette-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        {items.map((item, i) => (
          <div
            key={`${item.kind}-${item.label}-${i}`}
            className={`palette-item${i === active ? " active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(item);
            }}
          >
            <span className="gray palette-kind">{item.kind}</span>
            <span className="menu-code">{item.label}</span>
            <span className="white">{item.detail}</span>
          </div>
        ))}
        {!items.length && <div className="gray palette-item">No matches</div>}
      </div>
    </div>
  );
}
