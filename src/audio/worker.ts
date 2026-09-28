import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { browserSafe, decodeAny, decodeWav, decodeWithFfmpeg, ffmpegPath, oggInsideWav, peaks, transcodeToWav, wavFormat, type Pcm } from "./decode.ts";
import { OUT_RATE, renderPreview, soundKey, soundsNeeded } from "./render.ts";
import { listZip, readEntry } from "../parsers/zip.ts";
import type { Model } from "../parsers/model.ts";

type Job = { kind: "peaks"; file: string } | { kind: "prepare"; file: string; out: string } | { kind: "render"; model: Model; zips: string[]; sounds: { name: string; file: string }[]; out: string };

const AUDIO = /\.(wav|flac|ogg|mp3|aiff?)$/i;

async function loadSound(data: Buffer, scratch: string): Promise<Pcm> {
  const fmt = wavFormat(data);
  if (fmt === 1 || fmt === 3 || fmt === 0xfffe) return decodeWav(data);
  fs.writeFileSync(scratch, oggInsideWav(data) ?? data);
  try {
    return await decodeWithFfmpeg(scratch, 60, 120, OUT_RATE);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

function toMp3(wav: string, mp3: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "160k", "-f", "mp3", mp3], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("error", () => (clearTimeout(timer), resolve(false)));
    p.on("close", (code) => (clearTimeout(timer), resolve(code === 0 && fs.existsSync(mp3))));
  });
}

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
  const needed = new Set(soundsNeeded(job.model));
  const sounds = new Map<string, Pcm>();
  const scratch = `${job.out}.sound`;
  const take = async (name: string, read: () => Buffer) => {
    const key = soundKey(name);
    if (!needed.has(key) || sounds.has(key)) return;
    try {
      sounds.set(key, await loadSound(read(), scratch));
    } catch {
      /* a sound that can't be read is reported as missing by the renderer */
    }
  };
  for (const s of job.sounds) await take(s.name, () => fs.readFileSync(s.file));
  for (const z of job.zips) {
    const zip = fs.readFileSync(z);
    for (const e of listZip(zip)) if (AUDIO.test(e.name)) await take(e.name, () => Buffer.from(readEntry(zip, e, 512 * 1024 ** 2)));
  }
  const r = renderPreview(job.model, sounds);
  if (!r.ok) return r;
  const wav = `${job.out}.wav`;
  fs.writeFileSync(wav, r.wav);
  const mp3 = await toMp3(wav, job.out);
  if (!mp3) fs.renameSync(wav, job.out);
  else fs.rmSync(wav, { force: true });
  return { ok: true, seconds: r.seconds, standIns: r.standIns, missing: r.missing, contentType: mp3 ? "audio/mpeg" : "audio/wav" };
}

run(workerData as Job).then(
  (r) => parentPort!.postMessage(r),
  (e: unknown) => parentPort!.postMessage({ ok: false, reason: e instanceof Error && e.name === "DecodeError" ? e.message : "The audio couldn't be read." })
);
