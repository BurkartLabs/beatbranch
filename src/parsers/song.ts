import { emptyModel, ParseError, uniqueSamples, type Model, type Track } from "./model.ts";
import { parseXml, walk } from "./xml.ts";
import { listZip, readEntry } from "./zip.ts";

export function parseSong(buf: Uint8Array): Model {
  const entries = listZip(buf);
  const song = entries.find((e) => /(^|\/)song\.xml$/i.test(e.name));
  if (!song) throw new ParseError("not a Studio One song");
  const m = emptyModel("song", "Studio One");
  const doc = parseXml(readEntry(buf, song).toString("utf8"));
  const tracks: Track[] = [];
  const samples: string[] = [];
  for (const el of walk(doc)) {
    const a = el.attrs;
    if (a.tempo && m.tempo === null && Number(a.tempo) > 0) m.tempo = Number(a.tempo);
    if (a.timeSignatureNumerator && a.timeSignatureDenominator) m.timeSignature = [Number(a.timeSignatureNumerator), Number(a.timeSignatureDenominator)];
    if (/Track$/.test(el.name) && a.name !== undefined) {
      const kind: Track["kind"] = /Audio|Media/i.test(el.name) ? "audio" : /Music|Instrument|Note/i.test(el.name) ? "midi" : /Folder|Group/i.test(el.name) ? "group" : "other";
      const beats = (m.tempo ?? 120) / 60;
      const clips = [...walk(el)]
        .filter((c) => /Event$/.test(c.name) && c.attrs.start !== undefined)
        .map((c) => ({ start: Number(c.attrs.start) * beats, length: Number(c.attrs.length ?? 0) * beats, name: c.attrs.name ?? "", kind: kind === "audio" ? ("audio" as const) : ("midi" as const), pattern: null, sample: c.attrs.url ?? c.attrs.path ?? null }));
      for (const c of clips) if (c.sample) samples.push(c.sample);
      tracks.push({ id: a.trackID ?? a.uid ?? String(tracks.length), name: a.name, kind, color: a.color ?? null, plugins: [], mixer: tracks.length, sends: [], clips });
    }
  }
  const mixer = entries.find((e) => /audiomixer\.xml$/i.test(e.name));
  if (mixer) {
    const mx = parseXml(readEntry(buf, mixer).toString("utf8"));
    for (const el of walk(mx)) {
      if (!/Channel$/.test(el.name) || !el.attrs.label) continue;
      const t = tracks.find((x) => x.name === el.attrs.label);
      if (!t) continue;
      for (const d of walk(el)) if (d.attrs.classID && d.attrs.name && !/Channel/.test(d.name)) t.plugins.push(d.attrs.name);
    }
  }
  m.tracks = tracks;
  m.mixer = tracks.map((t, i) => ({ index: i, name: t.name, plugins: t.plugins, sends: [] }));
  m.samples = uniqueSamples(samples);
  m.lengthBeats = Math.max(0, ...tracks.flatMap((t) => t.clips.map((c) => c.start + c.length)));
  if (!tracks.length) m.notes.push("No tracks were found in this song.");
  return m;
}

export function parseBitwig(buf: Uint8Array): Model {
  const b = Buffer.from(buf);
  if (b.toString("latin1", 0, 4) !== "BtWg") throw new ParseError("not a Bitwig project");
  const m = emptyModel("bwproject", "Bitwig Studio");
  m.metadataOnly = true;
  const head = b.toString("latin1", 0, Math.min(b.length, 4096));
  const version = head.match(/BtWg[0-9a-f]{0,40}?(\d+\.\d+(?:\.\d+)?)/);
  if (version) m.app = `Bitwig Studio ${version[1]}`;
  m.notes.push("Bitwig saves its projects in a private format. BeatBranch shows the file and its audio, but can't see inside it.");
  return m;
}

export function parseLogic(buf: Uint8Array): Model {
  const entries = listZip(buf);
  const pkg = entries.find((e) => /\.logicx\//i.test(e.name));
  if (!pkg) throw new ParseError("the zip does not hold a .logicx project");
  const m = emptyModel("logic", "Logic Pro");
  m.metadataOnly = true;
  const meta = entries.find((e) => /Alternatives\/\d+\/MetaData\.plist$/i.test(e.name));
  if (meta) {
    const text = readEntry(buf, meta, 4 * 1024 ** 2).toString("utf8");
    if (text.includes("<plist")) {
      const doc = parseXml(text);
      const dict = [...walk(doc)].find((e) => e.name === "dict");
      const kids = dict?.children ?? [];
      const read = (key: string) => {
        const i = kids.findIndex((k) => k.name === "key" && textOf(text, k) === key);
        return i >= 0 && kids[i + 1] ? textOf(text, kids[i + 1]!) : null;
      };
      const bpm = Number(read("BeatsPerMinute") ?? read("SongTempo"));
      if (bpm > 0) m.tempo = bpm;
      const key = read("SongKey");
      const gender = read("SongGenderKey");
      if (key) m.key = `${key}${gender ? ` ${gender}` : ""}`;
      const num = Number(read("SongSignatureNumerator"));
      const den = Number(read("SongSignatureDenominator"));
      if (num > 0 && den > 0) m.timeSignature = [num, den];
      const count = read("NumberOfTracks");
      if (count) m.notes.push(`The project has ${count} tracks.`);
    }
  }
  const name = pkg.name.match(/([^/]+)\.logicx\//i)?.[1];
  if (name) m.notes.unshift(`Project: ${name}`);
  m.samples = uniqueSamples(entries.filter((e) => /\/(Audio Files|Samples)\/[^/]+\.(wav|aif|aiff|caf|mp3|flac)$/i.test(e.name)).map((e) => e.name)).map((s) => ({ ...s, bundled: true }));
  m.notes.push("Logic keeps its tracks in a private format, so BeatBranch shows the project's details and audio, not its tracks.");
  return m;
}

function textOf(src: string, el: { start: number; end: number; name: string }): string {
  const open = src.indexOf(">", el.start) + 1;
  const close = src.lastIndexOf(`</${el.name}>`, el.end);
  return close > open ? src.slice(open, close).trim() : "";
}
