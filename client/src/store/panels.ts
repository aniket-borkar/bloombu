import { create } from "zustand";
import { setPendingQuestion } from "../ai";
import { isQuestion, parseCommand, type Command } from "../terminal/commandParser";
import { FUNCTIONS, SECURITY_MENUS } from "../terminal/functions";
import { sectorKeyText } from "../terminal/keymap";
import { sectorOf, type Sector } from "../terminal/sectors";

/** What a panel is displaying. `fn === null` with a security means the security menu. */
export interface Screen {
  security: string | null;
  fn: string | null;
}

export type LinkColor = "amber" | "green" | "blue" | "red";
export const LINK_COLORS: LinkColor[] = ["amber", "green", "blue", "red"];

export interface PanelState {
  id: number;
  input: string;
  screen: Screen;
  back: Screen[];
  forward: Screen[];
  page: number;
  pageCount: number;
  /** Selected numbered option on the current screen (e.g. GP range); null means the screen's default. */
  option: number | null;
  /** How many numbered options the current screen offers; 0 means numbers select menu items. */
  optionCount: number;
  /** Incremented when a new question is queued for an already-open ASK screen. */
  askNonce: number;
  /** Panels in the same link group follow each other's security. */
  link: LinkColor | null;
  message: string | null;
}

export const MAX_PANELS = 9;
export const LAYOUTS = [1, 2, 4, 6, 9] as const;
export type Layout = (typeof LAYOUTS)[number];

const HOME: Screen = { security: null, fn: null };

function blankPanel(id: number): PanelState {
  return {
    id,
    input: "",
    screen: HOME,
    back: [],
    forward: [],
    page: 0,
    pageCount: 1,
    option: null,
    optionCount: 0,
    askNonce: 0,
    link: null,
    message: null,
  };
}

const RESET_VIEW = { page: 0, pageCount: 1, option: null, optionCount: 0, message: null } as const;

const sameScreen = (a: Screen, b: Screen) => a.security === b.security && a.fn === b.fn;

/** Menu items for a screen, if it is a numbered menu. */
export function menuFor(screen: Screen): string[] | null {
  if (screen.fn !== null || !screen.security) return null;
  const sector = sectorOf(screen.security);
  return sector ? SECURITY_MENUS[sector] : null;
}

/** Login names allowed by chat: letters, digits, '.', '_' and '-', up to 24 characters. */
export function sanitizeUser(raw: string): string {
  const u = raw.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "_").slice(0, 24);
  return u || "GUEST";
}

/** Serializable workspace: layout plus each visible panel's screen and link group. */
export interface Workspace {
  layout: Layout;
  panels: { screen: Screen; link: LinkColor | null }[];
}

interface Store {
  panels: PanelState[];
  focused: number;
  layout: Layout;
  loggedIn: boolean;
  user: string;
  /** Incremented to pull keyboard focus back to the focused panel's command line. */
  focusNonce: number;
  login: (user?: string) => void;
  focus: (id: number) => void;
  focusNext: (delta: 1 | -1) => void;
  refocus: () => void;
  setLayout: (layout: Layout) => void;
  cycleLink: (id: number) => void;
  setLink: (id: number, link: LinkColor | null) => void;
  setInput: (id: number, input: string) => void;
  insertSector: (id: number, sector: Sector) => void;
  go: (id: number) => void;
  execute: (id: number, command: Command) => void;
  cancel: (id: number) => void;
  menu: (id: number) => void;
  forward: (id: number) => void;
  help: (id: number) => void;
  page: (id: number, delta: 1 | -1) => void;
  setPage: (id: number, page: number) => void;
  setPageCount: (id: number, count: number) => void;
  setOption: (id: number, option: number | null) => void;
  setOptionCount: (id: number, count: number) => void;
  loadDefaults: (securities: string[]) => void;
  snapshot: () => Workspace;
  restore: (w: Workspace) => void;
}

export const usePanels = create<Store>((set, get) => {
  const update = (id: number, fn: (p: PanelState) => Partial<PanelState>) =>
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, ...fn(p) } : p)) }));

  const move = (id: number, screen: Screen) =>
    update(id, (p) =>
      sameScreen(p.screen, screen)
        ? { input: "", message: null, page: 0 }
        : { screen, back: [...p.back, p.screen], forward: [], input: "", ...RESET_VIEW },
    );

  /** Navigate a panel; linked panels showing a security follow it to the new one. */
  const navigate = (id: number, screen: Screen) => {
    const { panels, layout } = get();
    const origin = panels.find((p) => p.id === id)!;
    move(id, screen);
    if (!origin.link || !screen.security || screen.security === origin.screen.security) return;
    for (const p of panels.slice(0, layout)) {
      if (p.id === id || p.link !== origin.link || !p.screen.security) continue;
      if (p.screen.fn && !FUNCTIONS[p.screen.fn]?.security) continue;
      move(p.id, { security: screen.security, fn: p.screen.fn });
    }
  };

  const fail = (id: number, message: string) => update(id, () => ({ message }));

  const execute = (id: number, cmd: Command) => {
    const panel = get().panels.find((p) => p.id === id)!;
    switch (cmd.kind) {
      case "empty":
        return update(id, () => ({ message: null }));
      case "load":
        return navigate(id, { security: cmd.security, fn: cmd.fn });
      case "function": {
        const def = FUNCTIONS[cmd.fn];
        if (def.security && !panel.screen.security) {
          return fail(id, `${cmd.fn} REQUIRES A SECURITY. E.G. AAPL US <EQUITY> ${cmd.fn} <GO>`);
        }
        return navigate(id, { security: panel.screen.security, fn: cmd.fn });
      }
      case "menuItem": {
        if (panel.optionCount > 0) {
          if (cmd.index < 1 || cmd.index > panel.optionCount) {
            return fail(id, `NO OPTION ${cmd.index} ON THIS SCREEN (1-${panel.optionCount})`);
          }
          return update(id, () => ({ option: cmd.index - 1, page: 0, input: "", message: null }));
        }
        const items = menuFor(panel.screen);
        const fn = items?.[cmd.index - 1];
        if (!fn) return fail(id, `NO MENU ITEM ${cmd.index} ON THIS SCREEN`);
        return navigate(id, { security: panel.screen.security, fn });
      }
      case "search":
        return fail(id, `"${cmd.query}" NOT RECOGNIZED. ADD A YELLOW KEY (F2-F11), PICK FROM THE LIST, OR ASK WITH ?`);
      case "ask":
        setPendingQuestion(id, cmd.question, cmd.depth ?? "quick");
        if (panel.screen.fn === "ASK") return update(id, (p) => ({ input: "", message: null, askNonce: p.askNonce + 1 }));
        return navigate(id, { security: panel.screen.security, fn: "ASK" });
      case "error":
        return fail(id, cmd.message);
    }
  };

  return {
    panels: Array.from({ length: MAX_PANELS }, (_, i) => blankPanel(i + 1)),
    focused: 1,
    layout: 4,
    loggedIn: false,
    user: "GUEST",
    focusNonce: 0,

    login: (user = "") => set({ loggedIn: true, user: sanitizeUser(user) }),

    focus: (id) => set((s) => ({ focused: id <= s.layout ? id : s.focused })),

    focusNext: (delta) => set((s) => ({ focused: ((s.focused - 1 + delta + s.layout) % s.layout) + 1 })),

    refocus: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),

    setLayout: (layout) => set((s) => ({ layout, focused: s.focused <= layout ? s.focused : 1 })),

    cycleLink: (id) =>
      update(id, (p) => {
        const i = p.link ? LINK_COLORS.indexOf(p.link) : -1;
        return { link: i + 1 < LINK_COLORS.length ? LINK_COLORS[i + 1] : null };
      }),

    setLink: (id, link) => update(id, () => ({ link })),

    setInput: (id, input) => update(id, () => ({ input: isQuestion(input) ? input : input.toUpperCase() })),

    insertSector: (id, sector) =>
      update(id, (p) => ({ input: `${p.input.trimEnd()} ${sectorKeyText(sector)} `.trimStart() })),

    go: (id) => execute(id, parseCommand(get().panels.find((p) => p.id === id)!.input)),

    execute,

    cancel: (id) => update(id, () => ({ input: "", message: null })),

    menu: (id) =>
      update(id, (p) => {
        const prev = p.back[p.back.length - 1];
        if (!prev) return { message: null };
        return { screen: prev, back: p.back.slice(0, -1), forward: [p.screen, ...p.forward], ...RESET_VIEW };
      }),

    forward: (id) =>
      update(id, (p) => {
        const [next, ...rest] = p.forward;
        if (!next) return {};
        return { screen: next, back: [...p.back, p.screen], forward: rest, ...RESET_VIEW };
      }),

    help: (id) => {
      const panel = get().panels.find((p) => p.id === id)!;
      navigate(id, { security: panel.screen.security, fn: "HELP" });
    },

    page: (id, delta) =>
      update(id, (p) => ({ page: Math.min(Math.max(p.page + delta, 0), p.pageCount - 1) })),

    setPage: (id, page) => update(id, (p) => ({ page: Math.min(Math.max(page, 0), p.pageCount - 1) })),

    setPageCount: (id, count) =>
      update(id, (p) => ({ pageCount: Math.max(count, 1), page: Math.min(p.page, Math.max(count, 1) - 1) })),

    setOption: (id, option) => update(id, () => ({ option })),

    setOptionCount: (id, count) =>
      update(id, (p) => ({
        optionCount: Math.max(count, 0),
        option: p.option !== null && p.option >= count ? null : p.option,
      })),

    loadDefaults: (securities) =>
      set((s) => ({
        panels: s.panels.map((p, i) =>
          securities[i] ? { ...blankPanel(p.id), screen: { security: securities[i], fn: null } } : p,
        ),
      })),

    snapshot: () => {
      const { layout, panels } = get();
      return { layout, panels: panels.slice(0, layout).map((p) => ({ screen: p.screen, link: p.link })) };
    },

    restore: (w) =>
      set((s) => ({
        layout: LAYOUTS.includes(w.layout) ? w.layout : 4,
        focused: 1,
        panels: s.panels.map((p, i) => {
          const saved = w.panels[i];
          if (!saved) return p;
          const screen = saved.screen && typeof saved.screen === "object" ? { security: saved.screen.security ?? null, fn: saved.screen.fn ?? null } : HOME;
          return { ...blankPanel(p.id), screen, link: LINK_COLORS.includes(saved.link as LinkColor) ? saved.link : null };
        }),
      })),
  };
});
