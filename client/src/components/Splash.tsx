import { useState } from "react";
import { authStatus, signIn } from "../auth";

export function Splash({ onLogin }: { onLogin: (user: string) => void }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secured = authStatus.authRequired;

  const submit = async (mode: "login" | "register") => {
    if (!secured) return onLogin(user);
    setBusy(true);
    setError(null);
    try {
      onLogin(await signIn(mode, user, password));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="splash" data-testid="splash">
      <form
        className="splash-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("login");
        }}
      >
        <div className="splash-logo">BLMBU</div>
        <div className="splash-sub">PROFESSIONAL SERVICE</div>
        <div className="splash-field">
          <label htmlFor="login">Login name</label>
          <input id="login" autoFocus value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" />
        </div>
        <div className="splash-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={secured ? "current-password" : "off"} />
        </div>
        <button type="submit" className="splash-go" disabled={busy}>
          GO
        </button>
        {secured && authStatus.signup && (
          <button type="button" className="tool-button" disabled={busy} onClick={() => void submit("register")}>
            Create account
          </button>
        )}
        {error && (
          <div className="yellow" data-testid="splash-error">
            {error}
          </div>
        )}
        <div className="splash-note">
          {secured
            ? "Sign in with your login name and password. Your login name is your identity for chat, portfolios, sheets and alerts."
            : "Demo terminal. No account needed: press <GO> (Enter) with any or no credentials. Your login name is used as your chat name in IB and MSG (GUEST if blank)."}{" "}
          Market data from free public sources and may be delayed. Not affiliated with Bloomberg L.P.
        </div>
      </form>
    </div>
  );
}
