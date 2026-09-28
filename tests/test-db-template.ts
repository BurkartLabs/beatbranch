// vitest's globalSetup: before any test file runs, migrate one database, the template every test's own database is
// copied from (tests/test-db.ts), so the migrations run once per pass rather than once per test.
import pg from "pg";
import { migrate, MIGRATIONS_DIR, PostgresDb } from "../src/db/db.js";
import { TEMPLATE_DATABASE } from "./test-db.js";

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set: run the tests through `npm test`, which starts a Postgres for them");
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DATABASE}`);
  } finally {
    await admin.end();
  }
  const target = new URL(url);
  target.pathname = `/${TEMPLATE_DATABASE}`;
  const db = new PostgresDb(target.toString());
  try {
    await migrate(db, MIGRATIONS_DIR);
  } finally {
    await db.close(); // a copy cannot be made while anything is connected to the template
  }
}
