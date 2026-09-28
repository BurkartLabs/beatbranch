/**
 * One full beatbranch suite at a time on this machine (job-hunt AB#1859, T-041): several sessions' suites at once
 * exhaust the PC, workers die, a rerun passes, and everyone learns to rerun until green. The lock is a file in the OS
 * temp folder, created exclusively; a holder that has exited, or has held it longer than any suite takes, is stale
 * and is taken over.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCK_FILE = path.join(os.tmpdir(), "beatbranch-test-suite.lock");
export const MAX_HOLD_MS = 20 * 60 * 1000;

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readHolder(file) {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(h.pid) && Number.isFinite(h.startedAt) ? h : null;
  } catch {
    return null;
  }
}

export function staleReason(holder, now = Date.now(), maxHoldMs = MAX_HOLD_MS, isAlive = alive) {
  if (!holder) return "the lock file could not be read";
  if (!isAlive(holder.pid)) return `process ${holder.pid} has exited`;
  if (now - holder.startedAt > maxHoldMs) return `it has been held for over ${Math.round(maxHoldMs / 60000)} minutes`;
  return null;
}

export async function acquireSuiteLock({ file = LOCK_FILE, pollMs = 1000, maxHoldMs = MAX_HOLD_MS, log = console.error, isAlive = alive, now = Date.now } = {}) {
  const mine = { pid: process.pid, cwd: process.cwd(), startedAt: now() };
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = readHolder(file);
    const stale = staleReason(holder, now(), maxHoldMs, isAlive);
    if (stale) {
      log(`[test-strict] taking over the suite lock: ${stale}.`);
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!told) {
      log(`[test-strict] waiting: another beatbranch suite is running on this machine (pid ${holder.pid}, ${holder.cwd}).`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return function release() {
    const holder = readHolder(file);
    if (holder && holder.pid === mine.pid && holder.startedAt === mine.startedAt) fs.rmSync(file, { force: true });
  };
}
