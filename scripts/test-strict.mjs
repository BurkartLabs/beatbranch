#!/usr/bin/env node
/**
 * `npm test` for beatbranch: one vitest pass on a real, throwaway PostgreSQL (scripts/embedded-postgres.mjs), judged
 * by what executed rather than by its exit code (scripts/strict-pass.mjs; T-008, T-040). A full run first takes the
 * machine's suite lock (scripts/suite-lock.mjs, T-041); a run filtered to named files is light and does not wait.
 * While vitest runs, CPU and free memory are sampled, so a failed run says how busy the machine was.
 *
 *   npm test                       the whole suite
 *   npm test -- src/auth/          the files matching a filter (vitest's own positional filters)
 */
import os from "node:os";
import { withPostgres } from "./embedded-postgres.mjs";
import { strictPass } from "./strict-pass.mjs";
import { acquireSuiteLock } from "./suite-lock.mjs";

const vitestArgs = process.argv.slice(2);
const filters = vitestArgs.filter((a) => !a.startsWith("-"));
const release = filters.length ? () => {} : await acquireSuiteLock();
process.on("exit", release);
process.on("SIGINT", () => process.exit(130));

const cpuTimes = () =>
  os.cpus().reduce((a, c) => {
    const busy = c.times.user + c.times.nice + c.times.sys + c.times.irq;
    return { busy: a.busy + busy, all: a.all + busy + c.times.idle };
  }, { busy: 0, all: 0 });
const first = cpuTimes();
let last = first;
let peakCpu = 0;
let minFree = os.freemem();
const sampler = setInterval(() => {
  const now = cpuTimes();
  if (now.all > last.all) peakCpu = Math.max(peakCpu, (now.busy - last.busy) / (now.all - last.all));
  last = now;
  minFree = Math.min(minFree, os.freemem());
}, 2000);

let pass;
try {
  pass = await withPostgres(async (url, version) => {
    console.log(`[test-strict] ${version}.`);
    return strictPass({ label: "postgres", args: vitestArgs, env: { TEST_DATABASE_URL: url } });
  });
} catch (error) {
  console.error(`\n[test-strict] could not start Postgres: ${error instanceof Error ? error.message : String(error)}`);
  console.error("[test-strict] a pass that did not run is not a pass.");
  pass = { ok: false, summary: "did not run", seconds: 0 };
}
clearInterval(sampler);
const end = cpuTimes();
if (end.all > last.all) peakCpu = Math.max(peakCpu, (end.busy - last.busy) / (end.all - last.all));
const avgCpu = end.all > first.all ? (end.busy - first.busy) / (end.all - first.all) : 0;

if (pass.ok) {
  console.log(`\n[test-strict] every file ran and every test executed: ${pass.summary} (${pass.seconds} s)`);
  process.exit(0);
}
const gb = (b) => (b / 2 ** 30).toFixed(1);
console.error(`\n[test-strict] the machine during this run: CPU averaged ${Math.round(avgCpu * 100)}%, peaked at ${Math.round(peakCpu * 100)}%; free memory fell to ${gb(minFree)} GB of ${gb(os.totalmem())} GB.`);
console.error(`\n[test-strict] FAILED: ${pass.summary} (${pass.seconds} s)`);
process.exit(1);
