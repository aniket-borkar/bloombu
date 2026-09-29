import { SCREEN_REGISTRY } from "../screens";
import { menuFor, usePanels, type PanelState } from "../store/panels";
import { FUNCTIONS } from "../terminal/functions";
import { sectorOf } from "../terminal/sectors";
import { CommandLine } from "./CommandLine";
import { HelpScreen } from "./HelpScreen";
import { HomeScreen } from "./HomeScreen";
import { MenuScreen } from "./MenuScreen";
import { NotImplementedScreen } from "./NotImplementedScreen";
import { SecurityScreen } from "./SecurityScreen";

function ScreenBody({ panel }: { panel: PanelState }) {
  const { security, fn } = panel.screen;

  if (fn === "HELP") return <HelpScreen panel={panel} />;
  if (!security && !fn) return <HomeScreen />;

  const def = fn ? SCREEN_REGISTRY[fn] : undefined;
  const isSecurityFn = fn ? FUNCTIONS[fn]?.security : false;

  if (fn && !isSecurityFn) {
    if (!def) return <NotImplementedScreen fn={fn} />;
    const Component = def.component;
    return <Component key={fn} panel={panel} security={security} fn={fn} />;
  }

  const items = menuFor(panel.screen);
  const sector = sectorOf(security);
  let body;
  if (!fn) {
    body = items ? <MenuScreen panel={panel} title={`${sector} Menu`} items={items} /> : null;
  } else if (!def) {
    body = <NotImplementedScreen fn={fn} />;
  } else if (def.sectors && (!sector || !def.sectors.includes(sector))) {
    body = (
      <div className="error-box" data-testid="wrong-sector">
        {fn} IS AVAILABLE FOR {def.sectors.join(", ").toUpperCase()} SECURITIES ONLY
      </div>
    );
  } else {
    const Component = def.component;
    body = <Component key={`${fn}|${security}`} panel={panel} security={security} fn={fn} />;
  }
  return <SecurityScreen security={security!}>{body}</SecurityScreen>;
}

function screenTitle(panel: PanelState): string {
  const { security, fn } = panel.screen;
  if (fn) return `${fn} ${FUNCTIONS[fn]?.name ?? ""}`;
  if (security) return "Security Menu";
  return "Blank Screen";
}

function popOut(panel: PanelState, user: string): void {
  const params = new URLSearchParams({ popout: "1", user });
  if (panel.screen.security) params.set("security", panel.screen.security);
  if (panel.screen.fn) params.set("fn", panel.screen.fn);
  window.open(`${location.pathname}?${params}`, `blmbu-${Date.now()}`, "popup,width=1000,height=700");
}

export function Panel({ panel, focused }: { panel: PanelState; focused: boolean }) {
  const focus = usePanels((s) => s.focus);
  const cycleLink = usePanels((s) => s.cycleLink);
  const user = usePanels((s) => s.user);
  const sector = sectorOf(panel.screen.security);

  return (
    <section
      className={`panel${focused ? " focused" : ""}`}
      data-testid={`panel-${panel.id}`}
      onMouseDown={() => focus(panel.id)}
    >
      <div className="panel-title">
        <span>
          <button
            className={`link-chip ${panel.link ?? "none"}`}
            title={panel.link ? `Linked (${panel.link}); click to change` : "Link this panel to others"}
            data-testid={`link-${panel.id}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => cycleLink(panel.id)}
          />{" "}
          {panel.id}) {sector ?? "Blank"}
        </span>
        <span>
          {screenTitle(panel)}{" "}
          <button className="popout" title="Pop out into a new window" onMouseDown={(e) => e.preventDefault()} onClick={() => popOut(panel, user)}>
            ⧉
          </button>
        </span>
      </div>
      <CommandLine panel={panel} focused={focused} />
      <div className="action-bar">
        <span className="action">
          <span className="action-num">96)</span> Actions ▾
        </span>
        <span className="action">
          <span className="action-num">97)</span> Output ▾
        </span>
        <span className="action">
          <span className="action-num">98)</span> Settings ▾
        </span>
        <span className="spacer" />
        {panel.pageCount > 1 && (
          <span className="action">
            Page {panel.page + 1}/{panel.pageCount}
          </span>
        )}
      </div>
      <div className="screen">
        <ScreenBody panel={panel} />
      </div>
    </section>
  );
}
