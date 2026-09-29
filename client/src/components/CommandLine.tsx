import { useEffect, useMemo, useRef, useState } from "react";
import { searchSecurities, type SearchResult } from "../api";
import { usePanels, type PanelState } from "../store/panels";
import { isQuestion, tokenize } from "../terminal/commandParser";
import { FUNCTION_LIST } from "../terminal/functions";
import { isFormField } from "../terminal/focus";
import { SECTOR_TOKENS } from "../terminal/sectors";
import { AutocompleteDropdown, type Suggestion } from "./AutocompleteDropdown";

interface Props {
  panel: PanelState;
  focused: boolean;
}

function functionMatches(tokens: string[]): Suggestion[] {
  if (tokens.length !== 1) return [];
  const q = tokens[0];
  return FUNCTION_LIST.filter((f) => f.code.startsWith(q) || (q.length >= 3 && f.name.toUpperCase().includes(q)))
    .sort((a, b) => Number(b.code === q) - Number(a.code === q) || a.code.length - b.code.length)
    .slice(0, 5)
    .map((f) => ({ kind: "function", code: f.code, name: f.name, extra: f.security ? "Security" : "Market" }));
}

export function CommandLine({ panel, focused }: Props) {
  const { setInput, execute } = usePanels.getState();
  const focusNonce = usePanels((s) => s.focusNonce);
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const tokens = useMemo(() => tokenize(panel.input), [panel.input]);
  const hasSector = tokens.some((t) => t in SECTOR_TOKENS);
  const searchable = tokens.length > 0 && !hasSector && !/^\d+$/.test(tokens.join("")) && !isQuestion(panel.input);
  const query = searchable ? tokens.join(" ") : "";

  useEffect(() => {
    if (focused && !isFormField(document.activeElement)) inputRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (focused && focusNonce) inputRef.current?.focus();
  }, [focusNonce]);

  useEffect(() => {
    setCaret(inputRef.current?.selectionStart ?? panel.input.length);
  }, [panel.input]);

  useEffect(() => {
    setActive(-1);
    setDismissed(false);
    if (!query) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      searchSecurities(query, ctrl.signal)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  const items: Suggestion[] = useMemo(() => {
    if (!query) return [];
    const secs: Suggestion[] = results.slice(0, 8).map((r) => ({
      kind: "security",
      code: r.security,
      name: r.name,
      extra: r.exchange ?? "",
    }));
    return [...functionMatches(tokens), ...secs];
  }, [query, results, tokens]);

  const showDropdown = focused && !dismissed && items.length > 0;

  const pick = (item: Suggestion) => {
    setDismissed(true);
    execute(
      panel.id,
      item.kind === "function" ? { kind: "function", fn: item.code } : { kind: "load", security: item.code, fn: null },
    );
  };

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? panel.input.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(true);
    }
  };

  const text = panel.input;
  const at = Math.min(caret, text.length);

  return (
    <div className="cmdline" onMouseDown={() => inputRef.current?.focus()}>
      {panel.screen.security && <span className="cmdline-security">{panel.screen.security}</span>}
      <span className="cmdline-input">
        {text.slice(0, at)}
        <span className="cursor" />
        {text.slice(at)}
        <input
          ref={inputRef}
          value={text}
          aria-label={`Panel ${panel.id} command line`}
          data-testid={`cmd-${panel.id}`}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setInput(panel.id, e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onKeyDown={onKeyDown}
          data-cmdline="1"
          onBlur={() =>
            setTimeout(() => {
              if (usePanels.getState().focused === panel.id && !isFormField(document.activeElement)) {
                inputRef.current?.focus();
              }
            }, 0)
          }
        />
      </span>
      {panel.message && <span className="cmdline-message">{panel.message}</span>}
      {showDropdown && <AutocompleteDropdown items={items} active={active} onPick={pick} onHover={setActive} />}
    </div>
  );
}
