// Users and sessions. Every function that touches a user's data takes the user id first. Two failure reasons answer
// byte for byte the same (an unknown email, a wrong password) and take the same time: the decoy hash below.
import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { hashPassword, verifyPassword } from "./password.js";

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** However active a session is, it ends this long after sign-in. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A handle can change once this long after its last change (AB#2736: "editable once set with a cooldown"). */
export const HANDLE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  role: "producer" | "admin";
}

export interface Session {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: number;
}

export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const Password = z.string().min(12, "at least 12 characters").max(256);
/** Letters, digits and single hyphens, 3 to 30 characters, lower-cased: it is part of a URL (/@handle). */
export const Handle = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/, "3 to 30 letters, digits or hyphens, starting and ending with a letter or digit")
  .refine((v) => !v.includes("--"), "no double hyphens");
export const DisplayName = z.string().trim().min(1).max(80).refine((v) => !/[<>\u0000-\u001f]/.test(v), "letters, numbers and ordinary punctuation only");
export const Bio = z.string().trim().max(500).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), "ordinary text only");

/** Handles that would collide with a route or read as the site's own voice. */
export const RESERVED_HANDLES = new Set(["admin", "administrator", "beatbranch", "api", "static", "login", "register", "logout", "explore", "new", "p", "b", "settings", "healthz", "version", "report", "support", "help", "about", "terms", "privacy", "www", "mail", "root", "system", "moderator", "staff", "official"]);

export const NewUser = z.object({ email: Email, password: Password, handle: Handle, displayName: DisplayName });

const toUser = (r: { id: string; email: string; handle: string; display_name: string; role: string }): User => ({
  id: r.id, email: r.email, handle: r.handle, displayName: r.display_name, role: r.role === "admin" ? "admin" : "producer"
});

export type RegisterResult = { ok: true; user: User } | { ok: false; reason: "email-taken" | "handle-taken" | "handle-reserved" };

/** A new account. The first account ever made is the admin, so the report inbox has a reader from day one. */
export async function createUser(db: Db, input: z.infer<typeof NewUser>, now = Date.now()): Promise<RegisterResult> {
  const user = NewUser.parse(input);
  if (RESERVED_HANDLES.has(user.handle)) return { ok: false, reason: "handle-reserved" };
  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(user.password);
  return db.transaction(async () => {
    if (await db.get("SELECT 1 AS found FROM users WHERE email = ?", [user.email])) return { ok: false, reason: "email-taken" } as const;
    if (await db.get("SELECT 1 AS found FROM users WHERE handle = ?", [user.handle])) return { ok: false, reason: "handle-taken" } as const;
    const first = !(await db.get("SELECT 1 AS found FROM users LIMIT 1"));
    const role = first ? "admin" : "producer";
    await db.run("INSERT INTO users (id, email, handle, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id, user.email, user.handle, user.displayName, passwordHash, role, now
    ]);
    return { ok: true, user: { id, email: user.email, handle: user.handle, displayName: user.displayName, role } } as const;
  });
}

// A hash of a random password, checked when the email is unknown, so a wrong email and a wrong password take the
// same time and give the same answer.
let decoyHash: Promise<string> | undefined;

export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const row = await db.get<{ id: string; email: string; handle: string; display_name: string; role: string; password_hash: string }>(
    "SELECT id, email, handle, display_name, role, password_hash FROM users WHERE email = ?",
    [email]
  );
  decoyHash ??= hashPassword(crypto.randomBytes(24).toString("base64url"));
  const ok = await verifyPassword(password, row ? row.password_hash : await decoyHash);
  return row && ok ? toUser(row) : null;
}

export async function userIdForEmail(db: Db, email: string): Promise<string | undefined> {
  return (await db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", [email]))?.id;
}

export async function getUser(db: Db, userId: string): Promise<User | null> {
  const row = await db.get<{ id: string; email: string; handle: string; display_name: string; role: string }>("SELECT id, email, handle, display_name, role FROM users WHERE id = ?", [userId]);
  return row ? toUser(row) : null;
}

export interface Profile extends User {
  bio: string;
  createdAt: number;
}

export async function getProfileByHandle(db: Db, handle: string): Promise<Profile | null> {
  const row = await db.get<{ id: string; email: string; handle: string; display_name: string; role: string; bio: string; created_at: number }>(
    "SELECT id, email, handle, display_name, role, bio, created_at FROM users WHERE handle = ?",
    [handle.toLowerCase()]
  );
  return row ? { ...toUser(row), bio: row.bio, createdAt: Number(row.created_at) } : null;
}

export type ProfileUpdate = { displayName: string; bio: string; handle?: string };
export type ProfileUpdateResult = { ok: true; handleChanged: boolean } | { ok: false; reason: "handle-taken" | "handle-reserved" | "handle-cooldown"; retryAt?: number };

/** Update the profile; a handle change is refused inside the cooldown, and the cooldown is measured from the last change. */
export async function updateProfile(db: Db, userId: string, input: ProfileUpdate, now = Date.now()): Promise<ProfileUpdateResult> {
  const displayName = DisplayName.parse(input.displayName);
  const bio = Bio.parse(input.bio);
  const handle = input.handle === undefined ? undefined : Handle.parse(input.handle);
  return db.transaction(async () => {
    const me = await db.get<{ handle: string; handle_changed_at: number | null }>("SELECT handle, handle_changed_at FROM users WHERE id = ?", [userId]);
    if (!me) throw new Error("no such user");
    let handleChanged = false;
    if (handle !== undefined && handle !== me.handle) {
      if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "handle-reserved" } as const;
      const changedAt = me.handle_changed_at === null ? null : Number(me.handle_changed_at);
      if (changedAt !== null && now - changedAt < HANDLE_COOLDOWN_MS) return { ok: false, reason: "handle-cooldown", retryAt: changedAt + HANDLE_COOLDOWN_MS } as const;
      if (await db.get("SELECT 1 AS found FROM users WHERE handle = ? AND id <> ?", [handle, userId])) return { ok: false, reason: "handle-taken" } as const;
      await db.run("UPDATE users SET handle = ?, handle_changed_at = ? WHERE id = ?", [handle, now, userId]);
      handleChanged = true;
    }
    await db.run("UPDATE users SET display_name = ?, bio = ? WHERE id = ?", [displayName, bio, userId]);
    return { ok: true, handleChanged } as const;
  });
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** A new session: the returned token goes in the cookie; the database keeps only its hash. */
export async function createSession(db: Db, userId: string, now = Date.now()): Promise<{ token: string; session: Session }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const expiresAt = now + SESSION_IDLE_MS;
  await db.run("INSERT INTO sessions (token_hash, id, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    hashToken(token), id, userId, csrfToken, now, now, expiresAt
  ]);
  return { token, session: { id, userId, csrfToken, expiresAt } };
}

/** The live session for a cookie token, extended on use; null for an unknown, malformed or expired token. */
export async function findSession(db: Db, token: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const hash = hashToken(token);
  const row = await db.get<{ id: string; user_id: string; csrf_token: string; created_at: number; expires_at: number }>(
    "SELECT id, user_id, csrf_token, created_at, expires_at FROM sessions WHERE token_hash = ?",
    [hash]
  );
  if (!row) return null;
  if (Number(row.expires_at) <= now || now - Number(row.created_at) >= SESSION_MAX_AGE_MS) {
    await db.run("DELETE FROM sessions WHERE token_hash = ?", [hash]);
    return null;
  }
  const expiresAt = now + SESSION_IDLE_MS;
  await db.run("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?", [now, expiresAt, hash]);
  return { id: row.id, userId: row.user_id, csrfToken: row.csrf_token, expiresAt };
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}
