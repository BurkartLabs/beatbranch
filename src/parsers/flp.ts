import { baseName, emptyModel, ParseError, uniqueSamples, type Clip, type MixerChannel, type Model, type Note, type Pattern, type Track } from "./model.ts";

export const EV = {
  CHAN_NEW: 64,
  PAT_NEW: 65,
  TEMPO_COARSE: 66,
  TEMPO_FINE: 156,
  TIMESIG_NUM: 17,
  TIMESIG_BEAT: 18,
  CHAN_FX: 22,
  CHAN_TYPE: 21,
  CHAN_NAME_OLD: 192,
  STEP_OLD: 91,
  SLOT_INDEX: 98,
  ARR_NEW: 99,
  INSERT_OUTPUT: 147,
  PAT_NAME: 193,
  TITLE: 194,
  SAMPLE_PATH: 196,
  VERSION: 199,
  PLUGIN_INTERNAL: 201,
  PLUGIN_NAME: 203,
  INSERT_NAME: 204,
  PAT_NOTES: 224,
  PLAYLIST: 233,
  INSERT_ROUTING: 235,
  INSERT_FLAGS: 236,
  TRACK_DATA: 238,
  TRACK_NAME: 239,
  ARR_NAME: 241
} as const;

export const PATTERN_BASE = 20480;
const MAX_EVENTS = 2_000_000;

interface RawEvent {
  id: number;
  value: number;
  data: Uint8Array | null;
}

export function events(buf: Uint8Array): { ppq: number; events: RawEvent[] } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 22 || b.toString("latin1", 0, 4) !== "FLhd") throw new ParseError("not an FL Studio project");
  const headerLen = b.readUInt32LE(4);
  if (headerLen < 6 || 8 + headerLen + 8 > b.length) throw new ParseError("the file's header is damaged");
  const ppq = b.readUInt16LE(12);
  let at = 8 + headerLen;
  if (b.toString("latin1", at, at + 4) !== "FLdt") throw new ParseError("the file's data block is missing");
  const dataLen = b.readUInt32LE(at + 4);
  at += 8;
  if (at + dataLen > b.length) throw new ParseError("the file is cut short");
  const end = at + dataLen;
  const out: RawEvent[] = [];
  while (at < end) {
    if (out.length > MAX_EVENTS) throw new ParseError("the file holds too many events");
    const id = b[at]!;
    at += 1;
    if (id < 64) {
      if (at + 1 > end) throw new ParseError("the file is cut short");
      out.push({ id, value: b[at]!, data: null });
      at += 1;
    } else if (id < 128) {
      if (at + 2 > end) throw new ParseError("the file is cut short");
      out.push({ id, value: b.readUInt16LE(at), data: null });
      at += 2;
    } else if (id < 192) {
      if (at + 4 > end) throw new ParseError("the file is cut short");
      out.push({ id, value: b.readUInt32LE(at), data: null });
      at += 4;
    } else {
      let size = 0;
      let shift = 0;
      for (;;) {
        if (at >= end || shift > 28) throw new ParseError("an event's size is damaged");
        const byte = b[at]!;
        at += 1;
        size |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      if (size < 0 || at + size > end) throw new ParseError("an event runs past the end of the file");
      out.push({ id, value: size, data: b.subarray(at, at + size) });
      at += size;
    }
  }
  if (ppq < 24 || ppq > 9600) throw new ParseError("the project's timing is damaged");
  return { ppq, events: out };
}

function text(data: Uint8Array, utf16: boolean): string {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const raw = utf16 ? b.toString("utf16le") : b.toString("latin1");
  return raw.replace(/\u0000+$/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
}

function versionUtf16(v: string): boolean {
  const [maj, min] = v.split(".").map((n) => Number(n));
  if (!Number.isFinite(maj)) return true;
  return maj! > 11 || (maj === 11 && (min ?? 0) >= 5);
}

const PLAUSIBLE_TICKS = 1 << 27;

export function playlistItemSize(d: Buffer): 32 | 60 | 0 {
  const fits = (size: 32 | 60) => {
    if (d.length === 0 || d.length % size !== 0) return false;
    for (let o = 0; o < d.length; o += size) if (d.readUInt32LE(o) >= PLAUSIBLE_TICKS || d.readUInt32LE(o + 8) >= PLAUSIBLE_TICKS) return false;
    return true;
  };
  if (fits(60)) return 60;
  if (fits(32)) return 32;
  return 0;
}

export function parseFlp(buf: Uint8Array, bundled: Set<string> = new Set()): Model {
  const { ppq, events: evs } = events(buf);
  const m = emptyModel("flp", "FL Studio");
  let utf16 = true;
  let version = "";
  let tempoFine: number | null = null;
  let tempoCoarse: number | null = null;
  let sigNum: number | null = null;
  let sigBeat: number | null = null;

  interface Chan { index: number; name: string; plugin: string | null; sample: string | null; insert: number | null; kind: number }
  const chans: Chan[] = [];
  let chan: Chan | null = null;
  const pats = new Map<number, { name: string; notes: { pos: number; len: number; key: number; vel: number; channel: number }[] }>();
  let pat: number | null = null;
  let legacySteps = false;
  const items: { pos: number; len: number; ref: number; track: number }[] = [];
  const trackNames = new Map<number, string>();
  let trackIndex: number | null = null;
  const inserts: { name: string; plugins: string[]; sends: number[] }[] = [];
  let insert: { name: string; plugins: string[]; sends: number[] } | null = null;
  let slotPlugin: string | null = null;
  let mode: "project" | "channel" | "pattern" | "arrangement" | "mixer" = "project";

  for (const e of evs) {
    switch (e.id) {
      case EV.VERSION:
        version = text(e.data!, false);
        utf16 = versionUtf16(version);
        legacySteps = !versionUtf16(version) || Number(version.split(".")[0]) < 12;
        m.app = `FL Studio ${version.split(".").slice(0, 2).join(".")}`;
        break;
      case EV.TEMPO_FINE:
        tempoFine = e.value / 1000;
        break;
      case EV.TEMPO_COARSE:
        tempoCoarse = e.value;
        break;
      case EV.TIMESIG_NUM:
        if (mode === "project") sigNum = e.value;
        break;
      case EV.TIMESIG_BEAT:
        if (mode === "project") sigBeat = e.value;
        break;
      case EV.CHAN_NEW:
        chan = { index: e.value, name: "", plugin: null, sample: null, insert: null, kind: 0 };
        chans.push(chan);
        mode = "channel";
        break;
      case EV.CHAN_TYPE:
        if (chan && mode === "channel") chan.kind = e.value;
        break;
      case EV.CHAN_FX:
        if (chan && mode === "channel") chan.insert = e.value;
        break;
      case EV.SAMPLE_PATH:
        if (chan && mode === "channel") chan.sample = text(e.data!, utf16) || null;
        break;
      case EV.CHAN_NAME_OLD:
        if (mode === "channel" && chan && !chan.name) chan.name = text(e.data!, utf16);
        break;
      case EV.PLUGIN_INTERNAL: {
        const name = text(e.data!, utf16);
        if (mode === "channel" && chan) chan.plugin = name || chan.plugin;
        else if (mode === "mixer") slotPlugin = name || null;
        break;
      }
      case EV.PLUGIN_NAME: {
        const name = text(e.data!, utf16);
        if (mode === "channel" && chan) chan.name = name;
        else if (mode === "mixer" && name && !slotPlugin) slotPlugin = name;
        break;
      }
      case EV.PAT_NEW:
        pat = e.value;
        if (!pats.has(pat)) pats.set(pat, { name: "", notes: [] });
        mode = "pattern";
        break;
      case EV.STEP_OLD:
        if (legacySteps && chan && pat !== null && e.value >= 256 && e.value < 512) {
          pats.get(pat)!.notes.push({ pos: ((e.value & 0xff) >> 1) * (ppq / 4), len: ppq / 4, key: 60, vel: 100, channel: chan.index });
        }
        break;
      case EV.PAT_NAME:
        if (pat !== null) pats.get(pat)!.name = text(e.data!, utf16);
        break;
      case EV.PAT_NOTES: {
        if (pat === null) break;
        const d = Buffer.from(e.data!.buffer, e.data!.byteOffset, e.data!.byteLength);
        if (d.length % 24 !== 0) throw new ParseError("a pattern's notes are damaged");
        const list = pats.get(pat)!.notes;
        for (let o = 0; o < d.length; o += 24) {
          list.push({ pos: d.readUInt32LE(o), channel: d.readUInt16LE(o + 6), len: d.readUInt32LE(o + 8), key: d.readUInt16LE(o + 12), vel: d[o + 21]! });
        }
        break;
      }
      case EV.ARR_NEW:
        mode = "arrangement";
        break;
      case EV.PLAYLIST: {
        const d = Buffer.from(e.data!.buffer, e.data!.byteOffset, e.data!.byteLength);
        const size = playlistItemSize(d);
        if (!size) throw new ParseError("the playlist is damaged");
        const legacy = d.readUInt16LE(4) !== PATTERN_BASE;
        for (let o = 0; o < d.length; o += size) {
          const row = d.readUInt16LE(o + 12);
          items.push(
            legacy
              ? { pos: d.readUInt32LE(o), ref: PATTERN_BASE + (999 - row), len: d.readUInt32LE(o + 8), track: 999 - row }
              : { pos: d.readUInt32LE(o), ref: d.readUInt16LE(o + 6), len: d.readUInt32LE(o + 8), track: 499 - row }
          );
        }
        break;
      }
      case EV.TRACK_DATA: {
        const d = Buffer.from(e.data!.buffer, e.data!.byteOffset, e.data!.byteLength);
        trackIndex = d.length >= 4 ? d.readUInt32LE(0) : null;
        break;
      }
      case EV.TRACK_NAME:
        if (trackIndex !== null) trackNames.set(trackIndex, text(e.data!, utf16));
        break;
      case EV.INSERT_FLAGS:
        mode = "mixer";
        insert = { name: "", plugins: [], sends: [] };
        inserts.push(insert);
        slotPlugin = null;
        break;
      case EV.SLOT_INDEX:
        if (mode === "mixer" && insert && slotPlugin) insert.plugins.push(slotPlugin);
        slotPlugin = null;
        break;
      case EV.INSERT_NAME:
        if (mode === "mixer" && insert) insert.name = text(e.data!, utf16);
        break;
      case EV.INSERT_ROUTING:
        if (mode === "mixer" && insert) {
          const d = e.data!;
          for (let i = 0; i < d.length; i++) if (d[i]) insert.sends.push(i);
        }
        break;
      default:
        break;
    }
  }

  const beats = (ticks: number) => ticks / ppq;
  const tempo = tempoFine ?? tempoCoarse;
  if (tempo !== null && tempo >= 10 && tempo <= 999) m.tempo = Math.round(tempo * 1000) / 1000;
  if (sigNum && sigBeat && sigNum <= 32 && [1, 2, 4, 8, 16, 32].includes(sigBeat)) m.timeSignature = [sigNum, sigBeat];

  const patterns: Pattern[] = [];
  for (const [index, p] of [...pats.entries()].sort((a, b) => a[0] - b[0])) {
    const notes: Note[] = p.notes.map((n) => ({ start: beats(n.pos), length: beats(n.len), key: Math.min(127, n.key), velocity: Math.min(1, n.vel / 128), track: `ch${n.channel}` }));
    const lengthBeats = notes.reduce((mx, n) => Math.max(mx, n.start + n.length), 0);
    patterns.push({ id: String(index), name: p.name || `Pattern ${index}`, lengthBeats: Math.ceil(lengthBeats / 4) * 4, notes });
  }

  const signatures = new Map<string, number>();
  for (const ins of inserts.slice(1)) {
    const key = ins.sends.join(",");
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  const usual = [...signatures.entries()].sort((a, b) => b[1] - a[1])[0];
  const everywhere = usual && usual[1] > inserts.length / 2 && usual[0] ? usual[0].split(",").map(Number) : [0];
  const sendBase = inserts.length === 105 ? 100 : inserts.length === 127 ? 126 : -1;
  const insertName = (i: number, name: string) => name || (i === 0 ? "Master" : sendBase > 0 && i >= sendBase && i < sendBase + 4 ? `Send ${i - sendBase + 1}` : `Insert ${i}`);
  m.mixer = inserts.map((ins, i): MixerChannel => ({ index: i, name: insertName(i, ins.name), plugins: ins.plugins, sends: ins.sends.filter((s) => s !== i && !everywhere.includes(s)) }));

  const tracks: Track[] = chans.map((c) => {
    const ins = c.insert !== null ? m.mixer.find((x) => x.index === c.insert) ?? null : null;
    const plugins = [...(c.plugin && c.plugin !== "Sampler" ? [c.plugin] : []), ...(ins ? ins.plugins : [])];
    const name = c.name || c.plugin || (c.sample ? baseName(c.sample) : `Channel ${c.index + 1}`);
    return {
      id: `ch${c.index}`,
      name,
      kind: c.sample && (!c.plugin || c.plugin === "Sampler" || c.kind === 0 || c.kind === 4) ? "audio" : "instrument",
      color: null,
      plugins,
      mixer: c.insert,
      sends: ins ? ins.sends.map((s) => m.mixer.find((x) => x.index === s)?.name ?? `Insert ${s}`) : [],
      sample: c.sample,
      clips: []
    };
  });
  const byIndex = new Map(chans.map((c, i) => [c.index, tracks[i]!]));

  for (const it of items) {
    const start = beats(it.pos);
    const length = beats(it.len);
    if (it.ref >= PATTERN_BASE) {
      const pid = it.ref - PATTERN_BASE;
      const p = pats.get(pid);
      const channels = new Set((p?.notes ?? []).map((n) => n.channel));
      const name = p?.name || `Pattern ${pid}`;
      for (const ch of channels) {
        const t = byIndex.get(ch);
        if (t) t.clips.push({ start, length, name, kind: "pattern", pattern: String(pid), sample: null } satisfies Clip);
      }
    } else {
      const t = byIndex.get(it.ref);
      const c = chans.find((x) => x.index === it.ref);
      if (t) t.clips.push({ start, length, name: c?.sample ? baseName(c.sample) : t.name, kind: "audio", pattern: null, sample: c?.sample ?? null });
    }
  }
  for (const t of tracks) t.clips.sort((a, b) => a.start - b.start);
  m.tracks = tracks;
  m.patterns = patterns;
  m.lengthBeats = Math.max(0, ...items.map((i) => beats(i.pos + i.len)));
  const samples = uniqueSamples(chans.map((c) => c.sample ?? ""));
  const lower = new Set([...bundled].map((n) => baseName(n).toLowerCase()));
  m.samples = samples.map((s) => ({ ...s, bundled: lower.has(s.name.toLowerCase()) }));
  if (trackNames.size) m.notes.push(`Playlist tracks: ${[...trackNames.values()].filter(Boolean).join(", ")}`);
  return m;
}
