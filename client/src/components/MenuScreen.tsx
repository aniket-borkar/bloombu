import { useEffect } from "react";
import { usePanels, type PanelState } from "../store/panels";
import { FUNCTIONS, PAGE_SIZE } from "../terminal/functions";

interface Props {
  panel: PanelState;
  title: string;
  items: string[];
}

export function MenuScreen({ panel, title, items }: Props) {
  const { setPageCount, execute } = usePanels.getState();
  const pageCount = Math.ceil(items.length / PAGE_SIZE);

  useEffect(() => {
    setPageCount(panel.id, pageCount);
  }, [panel.id, pageCount, setPageCount]);

  const start = panel.page * PAGE_SIZE;
  const visible = items.slice(start, start + PAGE_SIZE);

  return (
    <div data-testid="security-menu">
      <div className="menu-title">{title}</div>
      <div className="menu">
        {visible.map((code, i) => {
          const n = start + i + 1;
          return (
            <div key={code} className="menu-item" onClick={() => execute(panel.id, { kind: "menuItem", index: n })}>
              <span className="menu-num">{n})</span>
              <span className="menu-code">{code}</span>
              <span className="menu-label">{FUNCTIONS[code].name}</span>
            </div>
          );
        })}
      </div>
      <div className="screen-note">
        Type a number and press &lt;GO&gt;, or click an item.
        {pageCount > 1 && " <PAGE FWD>/<PAGE BACK> for more."}
      </div>
    </div>
  );
}
