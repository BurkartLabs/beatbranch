import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { browserSafe, decodeAny, decodeWav, oggInsideWav, peaks, transcodeToWav } from "./decode.ts";
import { renderPreview } from "./render.ts";
import type { Model } from "../parsers/model.ts";

type Job = { kind: "peaks"; file: string } | { kind: "prepare"; file: string; out: string } | { kind: "render"; model: Model; zips: string[]; out: string };

async function run(job: Job) {
  if (job.kind === "peaks") {
    const fd = fs.openSync(job.file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    const pcm = await decodeAny(job.file, head, () => fs.readFileSync(job.file));
    return { ok: true, ...peaks(pcm) };
  }
  if (job.kind === "prepare") {
    const original = fs.readFileSync(job.file);
    if (browserSafe(original)) {
      const pcm = await decodeAny(job.file, original.subarray(0, 16), () => original);
      return { ok: true, transcoded: false, ...peaks(pcm) };
    }
    let source = job.file;
    const ogg = oggInsideWav(original);
    if (ogg) {
      source = path.join(path.dirname(job.out), `${path.basename(job.out)}.ogg`);
      fs.writeFileSync(source, ogg);
    }
    const ok = await transcodeToWav(source, job.out);
    if (source !== job.file) fs.rmSync(source, { force: true });
    if (!ok) return { ok: false, reason: "This audio file is in a format BeatBranch can't play." };
    return { ok: true, transcoded: true, ...peaks(decodeWav(fs.readFileSync(job.out))) };
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
