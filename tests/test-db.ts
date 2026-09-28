// Every database a test opens comes from here (job-hunt JH-70's shape, T-104): a copy of the migrated template
// database tests/test-db-template.ts made before the pass (CREATE DATABASE ... TEMPLATE is a file copy, far quicker
// than migrating), dropped when the test, or the file, is done with it. TEST_DATABASE_URL is set by
// scripts/test-strict.mjs, which started the Postgres; `vitest` run on its own has no database and says so.
import crypto from "node:crypto";
import { onTestFinished } from "vitest";
import pg from "pg";
import { PostgresDb } from "../src/db/db.js";

export const TEMPLATE_DATABASE = "bb_template";

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set: run the tests through `npm test`, which starts a Postgres for them");
  return url;
}

let adminClient: Promise<pg.Client> | undefined;

async function admin(sql: string): Promise<void> {
  adminClient ??= (async () => {
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    return client;
  })();
  await (await adminClient).query(sql);
}

type Cleanup = () => Promise<void>;
const pending: Cleanup[] = [];

/** tests/test-db-setup.ts calls this in each test file's root afterAll. */
export async function discardPendingTestDbs(): Promise<void> {
  for (let cleanup = pending.pop(); cleanup; cleanup = pending.pop()) await cleanup();
  if (adminClient) {
    const client = await adminClient;
    adminClient = undefined;
    await client.end().catch(() => undefined);
  }
}

function onDone(cleanup: Cleanup): void {
  try {
    onTestFinished(cleanup);
  } catch {
    pending.push(cleanup); // not inside a running test
  }
}

async function postgresDatabase(template: string): Promise<string> {
  const name = `bb_${crypto.randomBytes(6).toString("hex")}`;
  await admin(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  onDone(() => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh database with every migration applied, closed and dropped when the test (or file) is done. */
export async function testDb(): Promise<PostgresDb> {
  const db = new PostgresDb(await postgresDatabase(TEMPLATE_DATABASE), { max: 4 });
  onDone(() => db.close().catch(() => undefined));
  return db;
}

/** A fresh database with no tables at all, for a test that migrates it itself. */
export async function emptyTestDb(): Promise<PostgresDb> {
  const db = new PostgresDb(await postgresDatabase("template0"), { max: 4 });
  onDone(() => db.close().catch(() => undefined));
  return db;
}

/** A fresh migrated database's address, for a test that starts the app or a child process on it. */
export async function testDbUrl(): Promise<string> {
  return postgresDatabase(TEMPLATE_DATABASE);
}
