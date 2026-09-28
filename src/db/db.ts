// The database: Postgres only (DESIGN "Platform and stack"), through the `pg` package. `?` placeholders are rewritten
// to `$n`; a transaction runs on one pooled client that travels through AsyncLocalStorage, so a nested call joins it;
// BIGINT comes back as a number. DATABASE_URL is a secret (config.ts `secret()`), never logged, and never in an error
// message: a connection failure is replaced with one that names only its kind (T-009). A database on another host
// without TLS is refused before anything connects, and TLS always means verify-full, said here rather than left to
// pg (T-105). This file is the shape job-hunt's src/db/postgres.ts settled on (JH-69, AB#2274).
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import pg from "pg";
import { repoRoot } from "../paths.js";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Date;
export type Row = Record<string, unknown>;

export interface Db {
  all<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<number>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DatabaseConfigError extends Error {}
/** A connection failure, named by its kind only: never the host, the user, the database or the password. */
export class DatabaseConnectionError extends Error {}

export const MIGRATIONS_DIR = path.join(repoRoot(), "src", "db", "migrations");

/** `?` to `$1`, `$2`, ... in order, leaving alone a `?` inside quotes or a comment. */
export function rewritePlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, j);
      i = j;
    } else if (c === "?") {
      n += 1;
      out += `$${String(n)}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);
const TLS_PARAMS = ["sslmode", "ssl", "uselibpqcompat"];
const TLS_FILES = ["sslrootcert", "sslcert", "sslkey"];

/** The pool's options from DATABASE_URL. No message here quotes the URL or any part of it. */
export function connectionOptions(url: string): pg.PoolConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL could not be read as a postgres:// address.");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new DatabaseConfigError("DATABASE_URL must be a postgres:// or postgresql:// address.");
  const host = u.hostname.toLowerCase();
  const socket = u.searchParams.get("host");
  const local = host === "" ? socket === null || socket.startsWith("/") : LOCAL_HOSTS.has(host);
  const tls = TLS_MODES.has(u.searchParams.get("sslmode") ?? "") || u.searchParams.get("ssl") === "true";
  if (!local && !tls) {
    throw new DatabaseConfigError("DATABASE_URL names a database on another host without TLS, so its password would cross the network in the clear. Add sslmode=verify-full to it.");
  }
  if (!tls) return { connectionString: url };
  if (TLS_FILES.some((p) => u.searchParams.has(p))) {
    throw new DatabaseConfigError("DATABASE_URL names certificate files, which beatbranch does not use: the server's certificate is checked against the system's own trusted authorities. Remove them.");
  }
  for (const p of TLS_PARAMS) u.searchParams.delete(p);
  const server = host.replace(/^\[|\]$/g, "");
  return {
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: true, checkServerIdentity: (_name: string, cert: PeerCertificate) => checkServerIdentity(server, cert) }
  };
}

const INT8 = 20;
const NUMERIC = 1700;
const getTypeParser = ((oid: number, format?: "text" | "binary") =>
  oid === INT8 || oid === NUMERIC ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as "text")) as pg.CustomTypesConfig["getTypeParser"];

function connectionFailure(error: unknown): string | undefined {
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : "";
  if (/^(08|28|3D)/.test(code)) return `SQLSTATE ${code}`;
  if (/^E[A-Z]+$/.test(code)) return code;
  if (typeof e?.message === "string" && /connect|connection|terminat|timeout|password|authentication|SSL|certificate/i.test(e.message) && !/^[0-9A-Z]{5}$/.test(code)) return "connection";
  return undefined;
}

/** The same error, or one that names only its kind if it could carry any part of DATABASE_URL. */
export function scrubbed(error: unknown): unknown {
  const kind = connectionFailure(error);
  return kind ? new DatabaseConnectionError(`Could not reach the database (${kind}).`) : error;
}

const param = (v: SqlValue): unknown => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);

export class PostgresDb implements Db {
  private readonly pool: pg.Pool;
  private readonly scope = new AsyncLocalStorage<pg.PoolClient>();

  constructor(url: string, options: { max?: number; onIdleError?: (error: unknown) => void } = {}) {
    this.pool = new pg.Pool({ ...connectionOptions(url), max: options.max ?? 10, types: { getTypeParser } });
    this.pool.on("error", (error) => options.onIdleError?.(scrubbed(error)));
  }

  private async query(sql: string, params: SqlValue[] = []): Promise<pg.QueryResult> {
    const text = rewritePlaceholders(sql);
    const values = params.map(param);
    const client = this.scope.getStore();
    try {
      return await (client ? client.query(text, values) : this.pool.query(text, values));
    } catch (error) {
      throw scrubbed(error);
    }
  }

  async all<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }

  async get<T = Row>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }

  async run(sql: string, params?: SqlValue[]): Promise<number> {
    return (await this.query(sql, params)).rowCount ?? 0;
  }

  /** Several statements, no parameters: a migration file. */
  async exec(sql: string): Promise<void> {
    const client = this.scope.getStore();
    try {
      await (client ? client.query(sql) : this.pool.query(sql));
    } catch (error) {
      throw scrubbed(error);
    }
  }

  /** One pooled client for the whole of `fn`: committed if it resolves, rolled back if it throws; nested calls join. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return fn();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw scrubbed(error);
    }
    try {
      await client.query("BEGIN");
      const result = await this.scope.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw scrubbed(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// One constant for beatbranch's migrations, so two instances starting together take turns.
const MIGRATION_LOCK = 741_020_526;

/**
 * Apply the migrations in `dir` not yet recorded in schema_migrations, in file order, each in its own transaction
 * under an advisory lock. Files are `NNNN-name.sql`, numbered by story (P-SHARED-LINE: no registry to edit).
 */
export async function migrate(db: PostgresDb, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.transaction(async () => {
    await db.get("SELECT pg_advisory_xact_lock(?)", [MIGRATION_LOCK]);
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
  });
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-[a-z0-9-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const ran = await db.transaction(async () => {
      await db.get("SELECT pg_advisory_xact_lock(?)", [MIGRATION_LOCK]);
      if (await db.get("SELECT 1 AS done FROM schema_migrations WHERE name = ?", [file])) return false;
      await db.exec(sql);
      await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, Date.now()]);
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
}

/** Open the configured database and bring it up to date. The URL comes from `secret()`, never from Config. */
export async function openDatabase(url: string | undefined, options: { onIdleError?: (error: unknown) => void } = {}): Promise<PostgresDb> {
  if (!url) throw new DatabaseConfigError("DATABASE_URL is not set: beatbranch needs a PostgreSQL database. See README.md, \"Settings\".");
  const db = new PostgresDb(url, options);
  await migrate(db);
  return db;
}
