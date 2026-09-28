/**
 * A vitest reporter that keeps what the JSON reporter drops (job-hunt AB#1859): the error of a suite or a file that
 * failed outside any test. vitest marks every test in that file skipped with an empty message; this writes each such
 * error to a file test-strict reads, prints beside the verdict, and deletes.
 */
import { writeFileSync } from "node:fs";

export const HOOK_ERRORS_FILE = ".vitest-hook-errors.json";

const firstLine = (e) => String(e?.message ?? e ?? "").split("\n")[0].slice(0, 300);

export default class HookErrorsReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const found = [];
    for (const m of testModules) {
      for (const e of m.errors()) found.push({ file: m.moduleId, where: "the file", message: firstLine(e) });
      for (const s of m.children.allSuites()) {
        for (const e of s.errors()) found.push({ file: m.moduleId, where: s.fullName ?? s.name, message: firstLine(e) });
      }
    }
    for (const e of unhandledErrors) found.push({ file: "", where: "outside any file", message: firstLine(e) });
    writeFileSync(HOOK_ERRORS_FILE, JSON.stringify(found));
  }
}
