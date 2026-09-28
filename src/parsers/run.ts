import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ParseResult } from "./parse.ts";

export const SANDBOX = { memoryMb: 384, seconds: 30 };

export function runSandboxed<T>(entry: string, data: unknown, limits: { memoryMb: number; seconds: number } = SANDBOX): Promise<T | { ok: false; reason: string }> {
  const here = fileURLToPath(import.meta.url);
  const file = path.join(path.dirname(here), `${entry}${path.extname(here)}`);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | { ok: false; reason: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const worker = new Worker(file, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb, maxYoungGenerationSizeMb: 64, codeRangeSizeMb: 32, stackSizeMb: 8 } });
    const timer = setTimeout(() => {
      void worker.terminate();
      finish({ ok: false, reason: "Reading the project took too long, so it was stopped." });
    }, limits.seconds * 1000);
    worker.once("message", (m: T) => {
      finish(m);
      void worker.terminate();
    });
    worker.once("error", (e: Error & { code?: string }) => finish({ ok: false, reason: e.code === "ERR_WORKER_OUT_OF_MEMORY" ? "The project needed too much memory to read, so it was stopped." : "The project file couldn't be read." }));
    worker.once("exit", () => finish({ ok: false, reason: "The project file couldn't be read." }));
  });
}

export function parseInSandbox(job: { daw: string; name: string; project: string; samples: string | null }): Promise<ParseResult> {
  return runSandboxed<ParseResult>("worker", job);
}
