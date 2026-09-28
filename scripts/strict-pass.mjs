/**
 * One vitest run, judged by what executed, not by its exit code (T-008, T-040; carried from job-hunt). Fails when: no
 * JSON report; zero files or zero tests; any file that failed to load or ran no tests; any test not passed or failed
 * (skipped, todo, pending); any failure; any error outside a test.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { HOOK_ERRORS_FILE } from "./hook-errors-reporter.mjs";

const vitest = path.join("node_modules", "vitest", "vitest.mjs");

export async function strictPass({ label, args = [], env = {} }) {
  const tag = `[test-strict ${label}]`;
  const out = `.vitest-results-${label}.json`;
  const started = Date.now();
  const run = await new Promise((resolve) => {
    const reporters = ["--reporter=default", "--reporter=json", "--reporter=./scripts/hook-errors-reporter.mjs"];
    const child = spawn(process.execPath, [vitest, "run", ...reporters, `--outputFile.json=${out}`, ...args], {
      stdio: "inherit",
      env: { ...process.env, ...env }
    });
    child.on("close", (status) => resolve({ status: status ?? 1 }));
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  let report;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = null;
  }
  rmSync(out, { force: true });
  let hookErrors = [];
  try {
    hookErrors = JSON.parse(readFileSync(HOOK_ERRORS_FILE, "utf8"));
  } catch {
    hookErrors = [];
  }
  rmSync(HOOK_ERRORS_FILE, { force: true });

  if (!report) {
    console.error(`\n${tag} no JSON report was produced, so nothing can be said about this run (is the runner installed? npm ci).`);
    return { ok: false, summary: "no report", seconds };
  }

  const files = report.testResults ?? [];
  const tests = files.flatMap((f) => (f.assertionResults ?? []).map((t) => ({ file: f.name, name: t.fullName ?? t.title, status: t.status })));
  const notRun = tests.filter((t) => t.status !== "passed" && t.status !== "failed");
  const failed = tests.filter((t) => t.status === "failed");
  const emptyFiles = files.filter((f) => (f.assertionResults ?? []).length === 0);
  const rel = (f) => path.relative(process.cwd(), f);

  let bad = false;
  if (files.length === 0 || tests.length === 0) {
    console.error(`\n${tag} the runner reported ${files.length} test files and ${tests.length} tests. That is a failure, not a pass.`);
    bad = true;
  }
  if (emptyFiles.length) {
    console.error(`\n${tag} ${emptyFiles.length} test file(s) ran no tests (they failed to load, or hold none):`);
    for (const f of emptyFiles) console.error(`  - ${rel(f.name)}${f.message ? `: ${String(f.message).split("\n")[0]}` : ""}`);
    bad = true;
  }
  if (notRun.length) {
    console.error(`\n${tag} ${notRun.length} test(s) never ran:`);
    for (const t of notRun) console.error(`  - ${t.status}: ${t.name} (${rel(t.file)})`);
    bad = true;
  }
  if (hookErrors.length) {
    console.error(`\n${tag} ${hookErrors.length} error(s) outside any test (a hook, a file, a worker):`);
    for (const e of hookErrors) console.error(`  - ${e.file ? rel(e.file) : "(no file)"}, ${e.where}: ${e.message}`);
    bad = true;
  }
  const failedSuites = files.filter((f) => f.status === "failed" && (f.assertionResults ?? []).every((t) => t.status === "passed"));
  const onlyExitCode = !bad && failed.length === 0 && run.status !== 0;
  if (failed.length || run.status !== 0) bad = true;
  if (onlyExitCode) {
    console.error(`\n${tag} every test passed and every file ran, but vitest exited ${run.status}.`);
    if (failedSuites.length) {
      console.error(`${tag} the failure is in a suite, not a test, most likely a teardown that timed out:`);
      for (const f of failedSuites) console.error(`  - ${rel(f.name)}${f.message ? `: ${String(f.message).split("\n")[0]}` : ""}`);
    }
  }
  const summary = `${files.length} test files, ${tests.length} tests: ${tests.length - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run`;
  return { ok: !bad, summary, seconds };
}
