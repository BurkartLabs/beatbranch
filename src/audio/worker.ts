import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { decodeAny, peaks } from "./decode.ts";
import { renderPreview } from "./render.ts";
import type { Model } from "../parsers/model.ts";

type Job = { kind: "peaks"; file: string } | { kind: "render"; model: Model; zips: string[]; out: string };

async function run(job: Job) {
  if (job.kind === "peaks") {
    const fd = fs.openSync(job.file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    const pcm = await decodeAny(job.file, head, () => fs.readFileSync(job.file));
    return { ok: true, ...peaks(pcm) };
  }
  const r = renderPreview(job.model, job.zips.map((z) => fs.readFileSync(z)));
  if (!r.ok) return r;
  fs.writeFileSync(job.out, r.wav);
  return { ok: true, seconds: r.seconds };
}

run(workerData as Job).then(
  (r) => parentPort!.postMessage(r),
  (e: unknown) => parentPort!.postMessage({ ok: false, reason: e instanceof Error && e.name === "DecodeError" ? e.message : "The audio couldn't be read." })
);
