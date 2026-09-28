import type { CommitFile } from "../commits/repo.js";
import type { Model, Track } from "../parsers/model.js";

export type ChangeKind = "tracks" | "tempo" | "patterns" | "plugins" | "mixer" | "samples";

export interface Change {
  kind: ChangeKind;
  what: "added" | "removed" | "renamed" | "changed";
  text: string;
  track?: string;
}

export interface ModelDiff {
  changes: Change[];
  changedTracks: Set<string>;
  addedTracks: Set<string>;
}

function matchTracks(a: Track[], b: Track[]): { pairs: [Track, Track][]; added: Track[]; removed: Track[] } {
  const pairs: [Track, Track][] = [];
  const usedA = new Set<Track>();
  const usedB = new Set<Track>();
  for (const tb of b) {
    const ta = a.find((x) => !usedA.has(x) && x.id === tb.id);
    if (ta) {
      pairs.push([ta, tb]);
      usedA.add(ta);
      usedB.add(tb);
    }
  }
  for (const tb of b) {
    if (usedB.has(tb)) continue;
    const ta = a.find((x) => !usedA.has(x) && x.name === tb.name);
    if (ta) {
      pairs.push([ta, tb]);
      usedA.add(ta);
      usedB.add(tb);
    }
  }
  return { pairs, added: b.filter((t) => !usedB.has(t)), removed: a.filter((t) => !usedA.has(t)) };
}

const list = (xs: string[]) => xs.map((x) => `“${x}”`).join(", ");
const clipKey = (t: Track) => t.clips.map((c) => `${c.start.toFixed(3)}:${c.length.toFixed(3)}:${c.pattern ?? c.sample ?? c.name}`).join("|");

export function diffModels(a: Model, b: Model): ModelDiff {
  const changes: Change[] = [];
  const changedTracks = new Set<string>();
  const addedTracks = new Set<string>();
  if (a.tempo !== b.tempo) changes.push({ kind: "tempo", what: "changed", text: `Tempo went from ${a.tempo ?? "unknown"} to ${b.tempo ?? "unknown"} BPM` });
  if (a.key !== b.key && (a.key || b.key)) changes.push({ kind: "tempo", what: "changed", text: `Key went from ${a.key ?? "not set"} to ${b.key ?? "not set"}` });
  const sig = (m: Model) => (m.timeSignature ? `${m.timeSignature[0]}/${m.timeSignature[1]}` : "unknown");
  if (sig(a) !== sig(b)) changes.push({ kind: "tempo", what: "changed", text: `Time signature went from ${sig(a)} to ${sig(b)}` });

  const { pairs, added, removed } = matchTracks(a.tracks, b.tracks);
  for (const t of added) {
    changes.push({ kind: "tracks", what: "added", text: `New instrument “${t.name}”`, track: t.id });
    addedTracks.add(t.id);
  }
  for (const t of removed) changes.push({ kind: "tracks", what: "removed", text: `Removed instrument “${t.name}”` });
  for (const [ta, tb] of pairs) {
    if (ta.name !== tb.name) {
      changes.push({ kind: "tracks", what: "renamed", text: `“${ta.name}” is now called “${tb.name}”`, track: tb.id });
      changedTracks.add(tb.id);
    }
    const addP = tb.plugins.filter((p) => !ta.plugins.includes(p));
    const remP = ta.plugins.filter((p) => !tb.plugins.includes(p));
    if (addP.length) changes.push({ kind: "plugins", what: "added", text: `${tb.name}: added ${list(addP)}`, track: tb.id });
    if (remP.length) changes.push({ kind: "plugins", what: "removed", text: `${tb.name}: removed ${list(remP)}`, track: tb.id });
    if (!addP.length && !remP.length && ta.plugins.join("\n") !== tb.plugins.join("\n")) changes.push({ kind: "plugins", what: "changed", text: `${tb.name}: effects are in a different order`, track: tb.id });
    if (addP.length || remP.length) changedTracks.add(tb.id);
    const addS = tb.sends.filter((s) => !ta.sends.includes(s));
    const remS = ta.sends.filter((s) => !tb.sends.includes(s));
    if (addS.length) changes.push({ kind: "mixer", what: "added", text: `${tb.name} now also sends to ${list(addS)}`, track: tb.id });
    if (remS.length) changes.push({ kind: "mixer", what: "removed", text: `${tb.name} no longer sends to ${list(remS)}`, track: tb.id });
    if (addS.length || remS.length) changedTracks.add(tb.id);
    if (ta.mixer !== tb.mixer && ta.mixer !== null && tb.mixer !== null && a.format === "flp") {
      changes.push({ kind: "mixer", what: "changed", text: `${tb.name} moved from mixer insert ${ta.mixer} to ${tb.mixer}`, track: tb.id });
      changedTracks.add(tb.id);
    }
    if (clipKey(ta) !== clipKey(tb)) {
      const d = tb.clips.length - ta.clips.length;
      changes.push({ kind: "tracks", what: "changed", text: `${tb.name}: blocks moved or changed on the timeline${d ? ` (${d > 0 ? "+" : ""}${d})` : ""}`, track: tb.id });
      changedTracks.add(tb.id);
    }
  }
  const pa = new Map(a.patterns.map((p) => [p.id, p]));
  for (const p of b.patterns) {
    const old = pa.get(p.id);
    if (!old) continue;
    const key = (x: typeof p) => x.notes.map((n) => `${n.start}:${n.length}:${n.key}:${n.velocity.toFixed(2)}`).join("|");
    if (key(old) !== key(p)) {
      changes.push({ kind: "patterns", what: "changed", text: `Notes changed in “${p.name}”` });
      for (const t of b.tracks) if (t.clips.some((c) => c.pattern === p.id)) changedTracks.add(t.id);
    }
    if (old.name !== p.name) changes.push({ kind: "patterns", what: "renamed", text: `Pattern “${old.name}” is now called “${p.name}”` });
  }
  const sa = new Set(a.samples.map((s) => s.name.toLowerCase()));
  const sb = new Set(b.samples.map((s) => s.name.toLowerCase()));
  for (const s of b.samples) if (!sa.has(s.name.toLowerCase())) changes.push({ kind: "samples", what: "added", text: `New sound ${s.name}` });
  for (const s of a.samples) if (!sb.has(s.name.toLowerCase())) changes.push({ kind: "samples", what: "removed", text: `Removed sound ${s.name}` });
  const ma = new Map(a.mixer.map((m) => [m.index, m]));
  for (const m of b.mixer) {
    const old = ma.get(m.index);
    if (!old || a.format !== "flp") continue;
    const add = m.plugins.filter((p) => !old.plugins.includes(p));
    const rem = old.plugins.filter((p) => !m.plugins.includes(p));
    if (add.length || rem.length) changes.push({ kind: "mixer", what: "changed", text: `Mixer “${m.name}”: ${add.length ? `added ${list(add)}` : ""}${add.length && rem.length ? ", " : ""}${rem.length ? `removed ${list(rem)}` : ""}` });
    if (old.sends.join(",") !== m.sends.join(",")) changes.push({ kind: "mixer", what: "changed", text: `Mixer “${m.name}” sends its sound somewhere different now` });
  }
  return { changes, changedTracks, addedTracks };
}

export interface StemChange {
  name: string;
  kind: CommitFile["kind"];
  what: "added" | "removed" | "changed" | "same";
  before: CommitFile | null;
  after: CommitFile | null;
}

export function diffFiles(a: CommitFile[], b: CommitFile[]): StemChange[] {
  const key = (f: CommitFile) => `${f.kind}/${f.name.toLowerCase()}`;
  const ma = new Map(a.map((f) => [key(f), f]));
  const mb = new Map(b.map((f) => [key(f), f]));
  const out: StemChange[] = [];
  for (const [k, fb] of mb) {
    const fa = ma.get(k) ?? null;
    out.push({ name: fb.name, kind: fb.kind, what: !fa ? "added" : fa.hash === fb.hash ? "same" : "changed", before: fa, after: fb });
  }
  for (const [k, fa] of ma) if (!mb.has(k)) out.push({ name: fa.name, kind: fa.kind, what: "removed", before: fa, after: null });
  const order = { project: 0, bounce: 1, stem: 2, samples: 3 } as const;
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name));
}

export const KIND_TITLES: Record<ChangeKind, string> = { tracks: "Instruments", tempo: "Tempo and key", patterns: "Notes", plugins: "Effects and sound makers", mixer: "Mixer", samples: "Sounds" };
