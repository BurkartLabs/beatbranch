import { parentPort, workerData } from "node:worker_threads";

const job = workerData as { spin?: boolean } | null;
if (job?.spin) {
  for (;;) {
    Math.sqrt(Math.random());
  }
}
const hold: number[][] = [];
for (;;) hold.push(new Array(1_000_000).fill(1));
parentPort!.postMessage({ ok: true });
