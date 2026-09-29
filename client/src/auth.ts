import { ApiError, api } from "./api";

export interface AuthStatus {
  authRequired: boolean;
  user: string | null;
  signup: boolean;
}

/** Server sign-in settings, read once at startup; the terminal is open when the check fails. */
export let authStatus: AuthStatus = { authRequired: false, user: null, signup: true };

export async function loadAuthStatus(timeoutMs = 2000): Promise<AuthStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    authStatus = await api.auth.me(ctrl.signal);
  } catch {
    // Older servers have no /api/auth; keep the open defaults.
  } finally {
    clearTimeout(timer);
  }
  return authStatus;
}

export async function signIn(mode: "login" | "register", name: string, password: string): Promise<string> {
  try {
    const { user } = await (mode === "login" ? api.auth.login(name, password) : api.auth.register(name, password));
    authStatus = { ...authStatus, user };
    return user!;
  } catch (err) {
    throw new Error(err instanceof ApiError ? err.message : "Sign-in failed");
  }
}

export async function signOut(): Promise<void> {
  await api.auth.logout().catch(() => {});
  location.reload();
}
