import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import type express from "express";
import { normalizeUser } from "../chat/chat.js";

export const SESSION_COOKIE = "blmbu_session";
const SESSION_MS = 30 * 86_400_000;
const MIN_PASSWORD = 8;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 5 * 60_000;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Optional sign-in (AUTH=password): accounts with scrypt-hashed passwords and
 * server-side sessions. Login names stay the identity used everywhere else.
 */
export class AuthService {
  private db: DatabaseSync;
  private attempts = new Map<string, number[]>();

  constructor(
    file: string,
    readonly signupOpen = true,
    private now: () => number = Date.now,
  ) {
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }

  private userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM auth_users").get() as { n: number }).n;
  }

  /** The first account can always be created; later ones only while sign-up is open. */
  canRegister(): boolean {
    return this.signupOpen || this.userCount() === 0;
  }

  register(rawName: unknown, password: unknown): string {
    const name = normalizeUser(rawName);
    if (!name) throw new AuthError(400, "Login names are 1-24 letters, digits, '.', '_' or '-'");
    if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new AuthError(400, `Passwords need at least ${MIN_PASSWORD} characters`);
    if (!this.canRegister()) throw new AuthError(403, "New accounts are closed on this server; ask its administrator");
    const salt = randomBytes(16).toString("hex");
    try {
      this.db.prepare("INSERT INTO auth_users (name, salt, hash, created) VALUES (?, ?, ?, ?)").run(name, salt, hashPassword(password, salt).toString("hex"), this.now());
    } catch {
      throw new AuthError(409, `${name} is already taken`);
    }
    return this.createSession(name);
  }

  login(rawName: unknown, password: unknown, client = "unknown"): string {
    const name = normalizeUser(rawName);
    const key = `${client}|${name ?? ""}`;
    const t = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) throw new AuthError(429, "Too many attempts; try again in a few minutes");
    const row = name ? (this.db.prepare("SELECT salt, hash FROM auth_users WHERE name = ?").get(name) as { salt: string; hash: string } | undefined) : undefined;
    const ok = !!row && typeof password === "string" && timingSafeEqual(hashPassword(password, row.salt), Buffer.from(row.hash, "hex"));
    if (!ok || !name) {
      this.attempts.set(key, [...recent, t]);
      throw new AuthError(401, "Wrong login name or password");
    }
    this.attempts.delete(key);
    return this.createSession(name);
  }

  private createSession(user: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM auth_sessions WHERE expires <= ?").run(this.now());
    this.db.prepare("INSERT INTO auth_sessions (token_hash, user, expires) VALUES (?, ?, ?)").run(sha256(token), user, this.now() + SESSION_MS);
    return token;
  }

  userForToken(token: string | undefined): string | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT user, expires FROM auth_sessions WHERE token_hash = ?").get(sha256(token)) as { user: string; expires: number } | undefined;
    return row && row.expires > this.now() ? row.user : null;
  }

  userForRequest(req: IncomingMessage): string | null {
    return this.userForToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
  }
}

function setSession(res: express.Response, req: express.Request, token: string | null): void {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "set-cookie",
    token ? `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` : `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

/**
 * Sign-in routes plus the gate for every other /api route. With auth on, the
 * signed-in user replaces any `user` sent in the query or body, so existing
 * per-user routes cannot be pointed at someone else's data.
 */
export function registerAuth(app: express.Express, auth: AuthService | null): void {
  app.get("/api/auth/me", (req, res) => {
    res.json({ authRequired: !!auth, user: auth ? auth.userForRequest(req) : null, signup: auth ? auth.canRegister() : true });
  });
  if (!auth) return;
  const handle = (fn: (req: express.Request) => string) => (req: express.Request, res: express.Response) => {
    try {
      const token = fn(req);
      setSession(res, req, token);
      res.json({ user: auth.userForToken(token) });
    } catch (err) {
      if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
      else throw err;
    }
  };
  const body = (req: express.Request) => (req.body ?? {}) as { name?: unknown; password?: unknown };
  app.post("/api/auth/register", handle((req) => auth.register(body(req).name, body(req).password)));
  app.post("/api/auth/login", handle((req) => auth.login(body(req).name, body(req).password, req.ip)));
  app.post("/api/auth/logout", (req, res) => {
    auth.logout(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    setSession(res, req, null);
    res.json({ user: null });
  });
  app.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/auth/")) return next();
    const user = auth.userForRequest(req);
    if (!user) {
      res.status(401).json({ error: "SIGN IN REQUIRED" });
      return;
    }
    const url = new URL(req.url, "http://local");
    if (url.searchParams.has("user")) {
      url.searchParams.set("user", user);
      req.url = `${url.pathname}${url.search}`;
    }
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) (req.body as { user?: string }).user = user;
    res.locals.user = user;
    next();
  });
}
