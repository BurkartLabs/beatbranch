#!/usr/bin/env node
/**
 * `npm run dev`: a local BeatBranch with nothing to install. Starts an embedded PostgreSQL 17 whose data lives in
 * .embedded-postgres/ (gitignored, kept between runs), builds, and runs the server against it with a scratch
 * DATA_DIR under the same folder. Every setting can be overridden from the environment; DATABASE_URL set already
 * means your own Postgres is used and none is started. The password is generated once and kept in the data dir, and
 * is never printed. Stop with Ctrl+C: the server and the database both stop.
 *
 * T-095: this never touches an installed copy. Its port defaults to 4420 and its data to this checkout's own folder.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = path.join(root, ".embedded-postgres");
const dbDir = path.join(base, "db");
const dataDir = process.env.DATA_DIR ?? path.join(base, "data");
const port = Number(process.env.DEV_PG_PORT ?? 54329);
const passwordFile = path.join(base, "password");

fs.mkdirSync(base, { recursive: true });
let pg;
let url = process.env.DATABASE_URL;
if (!url) {
  if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, crypto.randomBytes(18).toString("base64url"), { mode: 0o600 });
  const password = fs.readFileSync(passwordFile, "utf8").trim();
  const said = [];
  pg = new EmbeddedPostgres({ databaseDir: dbDir, user: "postgres", password, port, persistent: true, initdbFlags: ["--encoding=UTF8", "--no-locale"], onLog: () => {}, onError: (m) => said.push(String(m?.message ?? m).trim()) });
  if (!fs.existsSync(path.join(dbDir, "PG_VERSION"))) await pg.initialise();
  // A Postgres that was killed rather than stopped leaves postmaster.pid behind, and the next start refuses to run.
  // The file's first line is the pid: if no such process is running, the file is stale and goes.
  const pidFile = path.join(dbDir, "postmaster.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").split(/\r?\n/)[0]);
    let running = false;
    try { process.kill(pid, 0); running = true; } catch (e) { running = e.code === "EPERM"; }
    if (running) {
      console.error(`dev: another Postgres (pid ${pid}) already runs on ${dbDir}. Stop it, or wait for the session holding it.`);
      process.exit(1);
    }
    fs.rmSync(pidFile, { force: true });
    console.log(`dev: removed a stale postmaster.pid (pid ${pid} is not running).`);
  }
  try {
    await pg.start();
  } catch (error) {
    console.error(`dev: Postgres did not start${error ? `: ${error.message ?? error}` : ""}.${said.length ? ` It said: ${said.slice(-3).join(" | ")}` : ""}`);
    process.exit(1);
  }
  url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  console.log(`dev: embedded PostgreSQL on 127.0.0.1:${port} (data in ${dbDir})`);
}

const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (build.status !== 0) {
  await pg?.stop();
  process.exit(build.status ?? 1);
}

const server = spawn(process.execPath, [path.join(root, "dist", "src", "server.js")], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url, DATA_DIR: dataDir, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" }
});
const stop = async () => {
  server.kill();
  await pg?.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", async (code) => {
  await pg?.stop().catch(() => undefined);
  process.exit(code ?? 0);
});
