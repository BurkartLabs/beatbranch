import { baseName, type Model, type Track } from "../parsers/model.ts";
import { encodeWav, type Pcm } from "./decode.ts";

export const OUT_RATE = 44100;
export const MAX_PREVIEW_SECONDS = 600;
const MAX_HIT_SECONDS = 8;
const TAIL_SECONDS = 1.5;

export type RenderResult = { ok: true; wav: Buffer; seconds: number; standIns: string[]; missing: string[] } | { ok: false; reason: string };

export function canRender(m: Model): { ok: true } | { ok: false; reason: string } {
  if (m.metadataOnly) return { ok: false, reason: "BeatBranch can't see inside this kind of project, so it can't play it. Add the full song or instrument tracks to hear it." };
  if (!m.tempo) return { ok: false, reason: "The project's tempo is unknown, so it can't be played." };
  if (!m.tracks.some((t) => t.clips.length)) return { ok: false, reason: "There's nothing on the timeline to play." };
  return { ok: true };
}

export function soundKey(name: string): string {
  return baseName(name).toLowerCase();
}

export function soundsNeeded(m: Model): string[] {
  const names = new Set<string>();
  for (const t of m.tracks) {
    if (t.sample) names.add(soundKey(t.sample));
    for (const c of t.clips) if (c.sample) names.add(soundKey(c.sample));
  }
  return [...names];
}

type Family = { harmonics: number[]; attack: number; decay: number; sustain: number; release: number; gain: number };

const FAMILIES: [RegExp, Family][] = [
  [/bass|808|sub/, { harmonics: [1, 0.5, 0.2], attack: 0.005, decay: 0.3, sustain: 0.7, release: 0.06, gain: 0.35 }],
  [/string|violin|cello|ensemble|pad|dream|choir|atmos|warm/, { harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.16], attack: 0.18, decay: 0.4, sustain: 0.8, release: 0.45, gain: 0.12 }],
  [/organ/, { harmonics: [1, 0.6, 0, 0.4, 0, 0.2], attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.08, gain: 0.14 }],
  [/rhodes|piano|keys|\bep\b|electric piano|bell|pluck|harp/, { harmonics: [1, 0.35, 0.12, 0.05], attack: 0.004, decay: 1.2, sustain: 0.15, release: 0.25, gain: 0.2 }],
  [/guitar/, { harmonics: [1, 0.6, 0.35, 0.2, 0.1], attack: 0.003, decay: 0.7, sustain: 0.2, release: 0.15, gain: 0.18 }],
  [/sax|brass|trumpet|horn|flute/, { harmonics: [1, 0.7, 0.45, 0.3, 0.2], attack: 0.04, decay: 0.2, sustain: 0.8, release: 0.1, gain: 0.16 }]
];
const LEAD: Family = { harmonics: [1, 0.5, 0.33, 0.25], attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.12, gain: 0.14 };
const TABLE = 2048;
const tables = new Map<Family, Float32Array>();

function tableFor(f: Family): Float32Array {
  let t = tables.get(f);
  if (!t) {
    t = new Float32Array(TABLE);
    const norm = f.harmonics.reduce((a, b) => a + b, 0);
    for (let i = 0; i < TABLE; i++) {
      let v = 0;
      f.harmonics.forEach((h, n) => (v += h * Math.sin((2 * Math.PI * (n + 1) * i) / TABLE)));
      t[i] = v / norm;
    }
    tables.set(f, t);
  }
  return t;
}

type Voice = { kind: "sample"; pcm: Pcm } | { kind: "kick" } | { kind: "synth"; family: Family };

function voiceFor(t: Track, sounds: Map<string, Pcm>): Voice | null {
  const pcm = t.sample ? sounds.get(soundKey(t.sample)) : undefined;
  if (pcm) return { kind: "sample", pcm };
  const words = `${t.name} ${t.plugins.join(" ")}`.toLowerCase();
  if (/fruit ?kick|\bkick\b|\b808 kick/.test(words)) return { kind: "kick" };
  if (t.kind === "audio") return null;
  return { kind: "synth", family: FAMILIES.find(([re]) => re.test(words))?.[1] ?? LEAD };
}

export function renderPreview(m: Model, sounds: Map<string, Pcm>): RenderResult {
  const ready = canRender(m);
  if (!ready.ok) return ready;
  const spb = 60 / m.tempo!;
  const clips = m.tracks.flatMap((t) => t.clips);
  const end = Math.min(MAX_PREVIEW_SECONDS, Math.max(...clips.map((c) => (c.start + c.length) * spb)) + TAIL_SECONDS);
  const frames = Math.ceil(end * OUT_RATE);
  const out = new Float32Array(frames);
  const patterns = new Map(m.patterns.map((p) => [p.id, p]));
  const standIns = new Set<string>();
  const missing = new Set<string>();
  let played = 0;

  const placePcm = (pcm: Pcm, at: number, seconds: number, rate: number, gain: number) => {
    const startF = Math.floor(at * OUT_RATE);
    const lenF = Math.min(frames - startF, Math.floor(seconds * OUT_RATE));
    const step = (pcm.rate / OUT_RATE) * rate;
    const src = pcm.channels;
    const n = src[0]!.length;
    for (let f = 0; f < lenF; f++) {
      const s = f * step;
      const i = Math.floor(s);
      if (i + 1 >= n) break;
      const frac = s - i;
      let v = 0;
      for (const ch of src) v += ch[i]! + (ch[i + 1]! - ch[i]!) * frac;
      out[startF + f]! += (v / src.length) * gain;
    }
    played++;
  };

  const placeKick = (at: number, gain: number) => {
    const startF = Math.floor(at * OUT_RATE);
    const lenF = Math.min(frames - startF, Math.floor(0.45 * OUT_RATE));
    let phase = 0;
    for (let f = 0; f < lenF; f++) {
      const t = f / OUT_RATE;
      const freq = 48 + 110 * Math.exp(-t * 28);
      phase += (2 * Math.PI * freq) / OUT_RATE;
      out[startF + f]! += Math.sin(phase) * Math.exp(-t * 7) * gain * 0.9;
    }
    played++;
  };

  const placeSynth = (fam: Family, at: number, seconds: number, key: number, gain: number) => {
    const table = tableFor(fam);
    const freq = 440 * 2 ** ((key - 69) / 12);
    const startF = Math.floor(at * OUT_RATE);
    const holdF = Math.floor(seconds * OUT_RATE);
    const lenF = Math.min(frames - startF, holdF + Math.floor(fam.release * OUT_RATE));
    const inc = (freq * TABLE) / OUT_RATE;
    const aF = Math.max(1, fam.attack * OUT_RATE);
    const dF = Math.max(1, fam.decay * OUT_RATE);
    const rF = Math.max(1, fam.release * OUT_RATE);
    let phase = 0;
    let level = 0;
    for (let f = 0; f < lenF; f++) {
      if (f < holdF) level = f < aF ? f / aF : fam.sustain + (1 - fam.sustain) * Math.exp(-(f - aF) / dF);
      const env = f < holdF ? level : level * Math.max(0, 1 - (f - holdF) / rF);
      out[startF + f]! += table[Math.floor(phase) % TABLE]! * env * gain * fam.gain;
      phase += inc;
    }
    played++;
  };

  for (const t of m.tracks) {
    if (!t.clips.length) continue;
    const voice = voiceFor(t, sounds);
    for (const c of t.clips) {
      const at = c.start * spb;
      if (at >= end) continue;
      if (c.kind === "audio") {
        const pcm = sounds.get(soundKey(c.sample ?? t.sample ?? ""));
        if (pcm) placePcm(pcm, at, c.length * spb, 1, 1);
        else missing.add(baseName(c.sample ?? t.sample ?? t.name));
        continue;
      }
      const p = c.pattern ? patterns.get(c.pattern) : undefined;
      if (!p) continue;
      if (!voice) {
        missing.add(t.sample ? baseName(t.sample) : t.name);
        continue;
      }
      if (voice.kind === "synth") standIns.add(t.name);
      for (const n of p.notes) {
        if ((n.track && n.track !== t.id) || n.start >= c.length) continue;
        const nAt = at + n.start * spb;
        const nLen = Math.min(n.length, c.length - n.start) * spb;
        if (voice.kind === "sample") placePcm(voice.pcm, nAt, MAX_HIT_SECONDS, 2 ** ((n.key - 60) / 12), n.velocity);
        else if (voice.kind === "kick") placeKick(nAt, n.velocity);
        else placeSynth(voice.family, nAt, nLen, n.key, n.velocity);
      }
    }
  }
  if (!played) {
    const gone = [...missing];
    return { ok: false, reason: gone.length ? `The sound${gone.length === 1 ? "" : "s"} ${gone.join(", ")} ${gone.length === 1 ? "isn't" : "aren't"} in this save, so the project can't be played. Add ${gone.length === 1 ? "it" : "them"} to the samples zip, or add the full song.` : "There's nothing on the timeline to play." };
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i]! *= 0.95 / peak;
  return { ok: true, wav: encodeWav([out], OUT_RATE), seconds: end, standIns: [...standIns], missing: [...missing] };
}
