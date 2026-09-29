export interface Suggestion {
  kind: "function" | "security";
  code: string;
  name: string;
  extra: string;
}

interface Props {
  items: Suggestion[];
  active: number;
  onPick: (item: Suggestion) => void;
  onHover: (index: number) => void;
}

export function AutocompleteDropdown({ items, active, onPick, onHover }: Props) {
  if (!items.length) return null;
  const functions = items.filter((i) => i.kind === "function");
  const securities = items.filter((i) => i.kind === "security");

  const row = (item: Suggestion) => {
    const index = items.indexOf(item);
    return (
      <div
        key={`${item.kind}:${item.code}`}
        className={`ac-item${index === active ? " active" : ""}`}
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(item);
        }}
        onMouseEnter={() => onHover(index)}
      >
        <span className="ac-code">{item.code}</span>
        <span className="ac-name">{item.name}</span>
        <span className="ac-extra">{item.extra}</span>
      </div>
    );
  };

  return (
    <div className="autocomplete" data-testid="autocomplete">
      {functions.length > 0 && <div className="ac-section">Functions</div>}
      {functions.map(row)}
      {securities.length > 0 && <div className="ac-section">Securities</div>}
      {securities.map(row)}
    </div>
  );
}
