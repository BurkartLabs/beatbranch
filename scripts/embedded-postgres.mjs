/**
 * A throwaway Postgres for the test suite: `withPostgres(fn)` starts a genuine PostgreSQL 17 through the
 * `embedded-postgres` package (T-090: real, not PGlite, whose socket server runs every client through one session, so
 * a race or a rollback test would pass for the wrong reason; and no Docker needed). Its data dir is a temp folder,
 * removed afterwards; the password is random; it listens on 127.0.0.1 on a free port; durability is off (nothing in
 * a throwaway database has to survive a crash). The address goes to the tests as TEST_DATABASE_URL and is printed
 * nowhere. TEST_DATABASE_URL already set (a Postgres of your own) is used as it is, and nothing is started.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const SETTINGS = ["fsync=off", "synchronous_commit=off", "full_page_writes=off", "max_connections=200"];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export async function withPostgres(fn) {
  if (process.env.TEST_DATABASE_URL) return fn(process.env.TEST_DATABASE_URL, "the Postgres named by TEST_DATABASE_URL");
  const password = crypto.randomBytes(18).toString("base64url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beatbranch-pg-"));
  const port = await freePort();
  const errors = [];
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password,
    port,
    // Removed by this script after stop (below), not by the package: on Windows its own removal raced the
    // stopping server and threw EPERM after every test had run.
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--no-locale"],
    postgresFlags: SETTINGS.flatMap((s) => ["-c", s]),
    onLog: () => {},
    onError: (m) => errors.push(String(m?.message ?? m).split("\n")[0])
  });
  let started = false;
  try {
    await pg.initialise();
    await pg.start();
    started = true;
  } catch (error) {
    const hint = errors.length ? ` Postgres said: ${errors.slice(-3).join(" | ")}` : "";
    removeQuietly(dir);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`);
  }
  try {
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    return await fn(url, `embedded PostgreSQL 17 on 127.0.0.1:${port} (temp data dir, removed after the run)`);
  } finally {
    if (started) {
      await pg.stop().catch(() => undefined);
      // stop() resolves before the postmaster has let go of its files on Windows; wait for its pid file to go.
      for (let i = 0; i < 40 && fs.existsSync(path.join(dir, "postmaster.pid")); i++) await new Promise((r) => setTimeout(r, 250));
    }
    removeQuietly(dir);
  }
}

/** The data dir is a temp folder: a removal Windows refuses (a file still closing) is noted, never a failed run. */
function removeQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.error(`[embedded-postgres] could not remove ${dir} (${error.code ?? error.message}); it is a temp folder and can be deleted by hand.`);
  }
}
