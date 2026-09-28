import { baseName, type Model } from "../parsers/model.ts";
import { listZip, readEntry } from "../parsers/zip.ts";
import { decodeWav, encodeWav, type Pcm } from "./decode.ts";

export const OUT_RATE = 44100;
export const MAX_PREVIEW_SECONDS = 600;

export type RenderResult = { ok: true; wav: Buffer; seconds: number } | { ok: false; reason: string };

export function canRender(m: Model): { ok: true } | { ok: false; reason: string } {
  if (m.metadataOnly) return { ok: false, reason: "BeatBranch can't see inside this kind of project, so it can't play it. Add the full song or instrument tracks to hear it." };
  if (!m.tempo) return { ok: false, reason: "The project's tempo is unknown, so it can't be played." };
  const clips = m.tracks.flatMap((t) => t.clips);
  if (clips.some((c) => c.kind !== "audio")) return { ok: false, reason: "This project uses instruments like synths, which only your music program can play. Add the instrument tracks or the full song to hear it here." };
  if (!clips.length) return { ok: false, reason: "There's nothing on the timeline to play." };
  return { ok: true };
}

export function renderPreview(m: Model, zips: Uint8Array[]): RenderResult {
  const ready = canRender(m);
  if (!ready.ok) return ready;
  const entries = zips.flatMap((z) => listZip(z).map((e) => ({ z, e })));
  const find = (sample: string) => entries.find(({ e }) => /\.wav$/i.test(e.name) && baseName(e.name).toLowerCase() === baseName(sample).toLowerCase());
  const cache = new Map<string, Pcm>();
  const spb = 60 / m.tempo!;
  const clips = m.tracks.flatMap((t) => t.clips);
  const end = Math.min(MAX_PREVIEW_SECONDS, Math.max(...clips.map((c) => (c.start + c.length) * spb)));
  const frames = Math.ceil(end * OUT_RATE);
  const out = [new Float32Array(frames), new Float32Array(frames)];
  for (const c of clips) {
    if (!c.sample) return { ok: false, reason: `“${c.name}” has no sound file, so the project can't be played.` };
    const hit = find(c.sample);
    if (!hit) return { ok: false, reason: `The sound ${baseName(c.sample)} isn't in the samples zip, so the project can't be played. Add it to the zip, or add the full song.` };
    let pcm = cache.get(hit.e.name);
    if (!pcm) {
      pcm = decodeWav(readEntry(hit.z, hit.e, 512 * 1024 ** 2));
      cache.set(hit.e.name, pcm);
    }
    const startF = Math.floor(c.start * spb * OUT_RATE);
    const lenF = Math.min(frames - startF, Math.floor(c.length * spb * OUT_RATE));
    const ratio = pcm.rate / OUT_RATE;
    const src = pcm.channels;
    const srcFrames = src[0]!.length;
    for (let f = 0; f < lenF; f++) {
      const s = Math.floor(f * ratio);
      if (s >= srcFrames) break;
      const l = src[0]![s]!;
      const r = (src[1] ?? src[0]!)[s]!;
      out[0]![startF + f]! += l;
      out[1]![startF + f]! += r;
    }
  }
  let peak = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  if (peak > 1) for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i]! /= peak;
  return { ok: true, wav: encodeWav(out, OUT_RATE), seconds: end };
}
