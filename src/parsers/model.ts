import { z } from "zod";

export const FORMATS = ["flp", "als", "rpp", "song", "bwproject", "logic"] as const;
export type ModelFormat = (typeof FORMATS)[number];

export const Note = z.object({ start: z.number().min(0), length: z.number().min(0), key: z.number().int().min(0).max(127), velocity: z.number().min(0).max(1) });
export const Pattern = z.object({ id: z.string(), name: z.string(), lengthBeats: z.number().min(0), notes: z.array(Note) });
export const Clip = z.object({
  start: z.number().min(0),
  length: z.number().min(0),
  name: z.string(),
  kind: z.enum(["pattern", "audio", "midi"]),
  pattern: z.string().nullable(),
  sample: z.string().nullable()
});
export const Track = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["instrument", "audio", "midi", "group", "return", "other"]),
  color: z.string().nullable(),
  plugins: z.array(z.string()),
  mixer: z.number().int().nullable(),
  sends: z.array(z.string()),
  clips: z.array(Clip)
});
export const MixerChannel = z.object({ index: z.number().int(), name: z.string(), plugins: z.array(z.string()), sends: z.array(z.number().int()) });
export const SampleRef = z.object({ path: z.string(), name: z.string(), bundled: z.boolean() });
export const Model = z.object({
  format: z.enum(FORMATS),
  app: z.string(),
  metadataOnly: z.boolean(),
  tempo: z.number().positive().nullable(),
  timeSignature: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable(),
  key: z.string().nullable(),
  lengthBeats: z.number().min(0),
  tracks: z.array(Track),
  patterns: z.array(Pattern),
  mixer: z.array(MixerChannel),
  samples: z.array(SampleRef),
  notes: z.array(z.string())
});
export type Note = z.infer<typeof Note>;
export type Pattern = z.infer<typeof Pattern>;
export type Clip = z.infer<typeof Clip>;
export type Track = z.infer<typeof Track>;
export type MixerChannel = z.infer<typeof MixerChannel>;
export type SampleRef = z.infer<typeof SampleRef>;
export type Model = z.infer<typeof Model>;

export class ParseError extends Error {}

export function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

export function markBundled(samples: SampleRef[], bundled: Set<string>): SampleRef[] {
  const names = new Set([...bundled].map((n) => baseName(n).toLowerCase()));
  return samples.map((s) => ({ ...s, bundled: names.has(s.name.toLowerCase()) }));
}

export function uniqueSamples(paths: string[]): SampleRef[] {
  const seen = new Set<string>();
  const out: SampleRef[] = [];
  for (const p of paths) {
    const clean = p.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push({ path: clean, name: baseName(clean), bundled: false });
  }
  return out;
}

export function emptyModel(format: ModelFormat, app: string): Model {
  return { format, app, metadataOnly: false, tempo: null, timeSignature: null, key: null, lengthBeats: 0, tracks: [], patterns: [], mixer: [], samples: [], notes: [] };
}
