import { emptyModel, ParseError, uniqueSamples, type Clip, type Model, type Pattern, type Track } from "./model.ts";
import { all, child, parseXml, path, under, val, walk, type El } from "./xml.ts";
import { gunzipLimited } from "./zip.ts";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TRACK_KINDS: Record<string, Track["kind"]> = { MidiTrack: "midi", AudioTrack: "audio", GroupTrack: "group", ReturnTrack: "return" };

export function alsXml(buf: Uint8Array): string {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipLimited(buf, 256 * 1024 ** 2) : Buffer.from(buf);
  return raw.toString("utf8");
}

export function trackName(t: El): string {
  const user = val(t, "Name", "UserName");
  return (user && user.trim()) || val(t, "Name", "EffectiveName") || t.name;
}

function devices(t: El): string[] {
  const chain = path(t, "DeviceChain", "DeviceChain", "Devices") ?? path(t, "DeviceChain", "Devices");
  if (!chain) return [];
  return chain.children.map((d) => {
    const plug = val(d, "PluginDesc", "VstPluginInfo", "PlugName") ?? val(d, "PluginDesc", "Vst3PluginInfo", "Name") ?? val(d, "PluginDesc", "AuPluginInfo", "Name");
    return plug ?? val(d, "UserName") ?? d.name.replace(/^Original/, "");
  }).filter((n) => n && n.trim());
}

function samplePath(ref: El | null): string | null {
  const file = child(ref, "FileRef");
  if (!file) return null;
  return val(file, "Path") ?? val(file, "RelativePath") ?? val(file, "Name");
}

export function parseAls(buf: Uint8Array): Model {
  const root = parseXml(alsXml(buf));
  const ableton = child(root, "Ableton");
  const live = child(ableton, "LiveSet");
  if (!ableton || !live) throw new ParseError("not an Ableton Live set");
  const m = emptyModel("als", `Ableton Live ${(ableton.attrs.Creator ?? "").replace(/^Ableton Live\s*/, "")}`.trim());
  const master = child(live, "MasterTrack") ?? child(live, "MainTrack");
  const tempo = Number(val(master, "DeviceChain", "Mixer", "Tempo", "Manual"));
  if (Number.isFinite(tempo) && tempo > 0) m.tempo = Math.round(tempo * 1000) / 1000;
  const sig = all(live, "RemoteableTimeSignature")[0];
  const num = Number(val(sig, "Numerator"));
  const den = Number(val(sig, "Denominator"));
  if (num > 0 && den > 0) m.timeSignature = [num, den];
  const scale = child(live, "ScaleInformation");
  const root_ = val(scale, "RootNote") ?? val(scale, "Root");
  const scaleName = val(scale, "Name");
  if (root_ !== null && /^\d+$/.test(root_)) m.key = `${NOTE_NAMES[Number(root_) % 12]} ${scaleName ?? ""}`.trim();

  const tracksEl = child(live, "Tracks");
  const patterns: Pattern[] = [];
  const samplePaths: string[] = [];
  const returns = (tracksEl?.children ?? []).filter((t) => t.name === "ReturnTrack").map(trackName);
  const tracks: Track[] = (tracksEl?.children ?? []).map((t, index) => {
    const id = t.attrs.Id ?? String(index);
    const clips: Clip[] = [];
    for (const c of walk(t)) {
      if ((c.name !== "MidiClip" && c.name !== "AudioClip") || !under(c, "ArrangerAutomation")) continue;
      const start = Number(val(c, "CurrentStart") ?? c.attrs.Time ?? 0);
      const end = Number(val(c, "CurrentEnd") ?? start);
      const name = val(c, "Name") ?? "";
      if (c.name === "MidiClip") {
        const pid = `${id}:${patterns.length}`;
        const notes = [];
        for (const kt of all(c, "KeyTrack")) {
          const key = Number(val(kt, "MidiKey"));
          for (const ne of all(kt, "MidiNoteEvent")) {
            notes.push({ start: Number(ne.attrs.Time ?? 0), length: Number(ne.attrs.Duration ?? 0), key: Math.max(0, Math.min(127, key)), velocity: Math.min(1, Number(ne.attrs.Velocity ?? 100) / 127) });
          }
        }
        for (const ne of all(c, "MidiNoteEvent")) {
          if (ne.parent?.parent?.name === "KeyTrack") continue;
          const key = Number(ne.attrs.NoteId ? val(ne.parent?.parent, "MidiKey") ?? 60 : 60);
          void key;
        }
        notes.sort((a, b) => a.start - b.start || a.key - b.key);
        patterns.push({ id: pid, name: name || "MIDI clip", lengthBeats: Math.max(0, end - start), notes });
        clips.push({ start, length: Math.max(0, end - start), name: name || "MIDI clip", kind: "midi", pattern: pid, sample: null });
      } else {
        const s = samplePath(child(c, "SampleRef"));
        if (s) samplePaths.push(s);
        clips.push({ start, length: Math.max(0, end - start), name: name || (s ? s.split(/[\\/]/).pop()! : "Audio clip"), kind: "audio", pattern: null, sample: s });
      }
    }
    for (const sr of all(t, "SampleRef")) {
      const s = samplePath(sr);
      if (s) samplePaths.push(s);
    }
    const sends: string[] = [];
    const holders = all(t, "TrackSendHolder");
    holders.forEach((h, i) => {
      const amount = Number(val(h, "Send", "Manual"));
      if (Number.isFinite(amount) && amount > 0.0003 && returns[i]) sends.push(returns[i]!);
    });
    const color = val(t, "Color") ?? val(t, "ColorIndex");
    clips.sort((a, b) => a.start - b.start);
    return { id, name: trackName(t), kind: TRACK_KINDS[t.name] ?? "other", color: color !== null ? `live:${color}` : null, plugins: devices(t), mixer: null, sends, clips };
  });
  m.tracks = tracks;
  m.patterns = patterns;
  m.mixer = tracks.map((t, i) => ({ index: i, name: t.name, plugins: t.plugins, sends: t.sends.map((s) => tracks.findIndex((x) => x.name === s)).filter((x) => x >= 0) }));
  m.samples = uniqueSamples(samplePaths);
  m.lengthBeats = Math.max(0, ...tracks.flatMap((t) => t.clips.map((c) => c.start + c.length)));
  return m;
}
