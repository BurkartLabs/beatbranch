// Every temporary folder a test makes, removed when the test is done with it (job-hunt AB#2254: 9,000 leaked
// folders once filled a disk). One made outside a test, or still held open when its test finished, goes once the
// whole file is done (tests/temp-dir-setup.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

const pending = new Set<string>();

function remove(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Still locked after the retries.
  }
  return !fs.existsSync(dir);
}

export function removePendingTempDirs(): void {
  for (const dir of [...pending]) if (remove(dir)) pending.delete(dir);
}

/** A new empty folder in the OS temp folder, named `<prefix>XXXXXX`, removed after the test (or file) that made it. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    onTestFinished(() => {
      if (!remove(dir)) pending.add(dir);
    });
  } catch {
    pending.add(dir);
  }
  return dir;
}
