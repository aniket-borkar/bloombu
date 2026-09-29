import { FUNCTIONS } from "../terminal/functions";

export function NotImplementedScreen({ fn }: { fn: string }) {
  const def = FUNCTIONS[fn];
  return (
    <div data-testid="not-implemented">
      <div className="menu-title">
        {fn} &lt;GO&gt; {def?.name ?? ""}
      </div>
      <div className="yellow">THIS FUNCTION IS NOT AVAILABLE IN THIS BUILD.</div>
      <div className="screen-note">
        Press &lt;MENU&gt; (Backspace) to return, or type another command and press &lt;GO&gt;.
      </div>
    </div>
  );
}
