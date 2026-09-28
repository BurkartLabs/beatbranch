// Rate limits that hold across restarts and processes (job-hunt JH-76's shape; AB#2141: the check and the count are
// one statement, so two callers cannot both take the last request in a window). A key is a user id or an address,
// never an email; a log line names the limit and the key's kind, never the key.
import type { Db } from "../db/db.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export type KeyKind = "address" | "user";

export interface RateLimit {
  max: number;
  windowMs: number;
  kind: KeyKind;
  says: string;
}

/** Every rate limit in the product, in one place. */
export const RATE_LIMITS = {
  /** Failed sign-ins from one address: ten in fifteen minutes, then that address waits. */
  "sign-in-address": { max: 10, windowMs: 15 * MINUTE, kind: "address", says: "Too many attempts." },
  /** Failed sign-ins for one account, from anywhere. */
  "sign-in-account": { max: 10, windowMs: 15 * MINUTE, kind: "user", says: "Too many attempts." },
  /** Registrations from one address: open sign-up (AB#4685) must not be a way to fill the users table. */
  "register-address": { max: 5, windowMs: HOUR, kind: "address", says: "That is as many accounts as an hour allows from here." },
  /** Commits: each one is hashed, stored and parsed. */
  commit: { max: 60, windowMs: HOUR, kind: "user", says: "That is as many commits as an hour allows." },
  /** Projects created. */
  "new-project": { max: 20, windowMs: HOUR, kind: "user", says: "That is as many new projects as an hour allows." },
  /** Reports: one account must not be able to bury the inbox. */
  report: { max: 10, windowMs: HOUR, kind: "user", says: "That is as many reports as an hour allows." }
} as const satisfies Record<string, RateLimit>;

export type LimitName = keyof typeof RATE_LIMITS;

export type Verdict = { ok: true } | { ok: false; retryAt: number };

async function prune(db: Db, now: number): Promise<void> {
  await db.run("DELETE FROM rate_limits WHERE reset_at <= ?", [now]);
}

async function current(db: Db, name: LimitName, key: string): Promise<{ hits: number; reset_at: number } | undefined> {
  return await db.get<{ hits: number; reset_at: number }>("SELECT hits, reset_at FROM rate_limits WHERE limit_name = ? AND limit_key = ?", [name, key]);
}

/** Count one request in a single statement, only while the key is under `max` when one is given. */
async function count(db: Db, name: LimitName, key: string, now: number, max?: number): Promise<boolean> {
  const insert = `INSERT INTO rate_limits (limit_name, limit_key, hits, reset_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (limit_name, limit_key) DO UPDATE SET hits = rate_limits.hits + 1`;
  const params = [name, key, now + RATE_LIMITS[name].windowMs];
  const changed = max === undefined ? await db.run(insert, params) : await db.run(`${insert} WHERE rate_limits.hits < ?`, [...params, max]);
  return changed > 0;
}

const verdict = (name: LimitName, row: { hits: number; reset_at: number } | undefined): Verdict =>
  row && Number(row.hits) >= RATE_LIMITS[name].max ? { ok: false, retryAt: Number(row.reset_at) } : { ok: true };

/** Count this request against the limit, or refuse it. A refused request is not counted. */
export async function takeLimit(db: Db, name: LimitName, key: string, now = Date.now()): Promise<Verdict> {
  return await db.transaction(async () => {
    await prune(db, now);
    if (await count(db, name, key, now, RATE_LIMITS[name].max)) return { ok: true };
    const row = await current(db, name, key);
    return { ok: false, retryAt: Number(row?.reset_at ?? now + RATE_LIMITS[name].windowMs) };
  });
}

/** Whether the key has reached the limit, without counting anything: sign-in counts only its failures. */
export async function checkLimit(db: Db, name: LimitName, key: string, now = Date.now()): Promise<Verdict> {
  return await db.transaction(async () => {
    await prune(db, now);
    return verdict(name, await current(db, name, key));
  });
}

/** Count one event against the limit without refusing anything (a failed sign-in). */
export async function countLimit(db: Db, name: LimitName, key: string, now = Date.now()): Promise<void> {
  await db.transaction(async () => {
    await prune(db, now);
    await count(db, name, key, now);
  });
}

export async function clearLimit(db: Db, name: LimitName, key: string): Promise<void> {
  await db.run("DELETE FROM rate_limits WHERE limit_name = ? AND limit_key = ?", [name, key]);
}

export function retryWords(retryAt: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((retryAt - now) / MINUTE));
  return minutes === 1 ? "in a minute" : `in ${String(minutes)} minutes`;
}

export const retryAfterSeconds = (retryAt: number, now = Date.now()): string => String(Math.max(1, Math.ceil((retryAt - now) / 1000)));
