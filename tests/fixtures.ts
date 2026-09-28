import zlib from "node:zlib";
import { EV, PATTERN_BASE } from "../src/parsers/flp.js";

function varlen(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

export class FlpWriter {
  private parts: Buffer[] = [];
  byte(id: number, v: number) {
    this.parts.push(Buffer.from([id, v]));
    return this;
  }
  word(id: number, v: number) {
    const b = Buffer.alloc(3);
    b[0] = id;
    b.writeUInt16LE(v, 1);
    this.parts.push(b);
    return this;
  }
  dword(id: number, v: number) {
    const b = Buffer.alloc(5);
    b[0] = id;
    b.writeUInt32LE(v >>> 0, 1);
    this.parts.push(b);
    return this;
  }
  data(id: number, d: Buffer) {
    this.parts.push(Buffer.from([id]), varlen(d.length), d);
    return this;
  }
  text(id: number, s: string, utf16 = true) {
    return this.data(id, Buffer.from(`${s}\u0000`, utf16 ? "utf16le" : "latin1"));
  }
  build(ppq = 96): Buffer {
    const body = Buffer.concat(this.parts);
    const head = Buffer.alloc(22);
    head.write("FLhd", 0, "latin1");
    head.writeUInt32LE(6, 4);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(3, 10);
    head.writeUInt16LE(ppq, 12);
    head.write("FLdt", 14, "latin1");
    head.writeUInt32LE(body.length, 18);
    return Buffer.concat([head, body]);
  }
}

export function notes(list: { pos: number; len: number; key: number; vel: number; channel: number }[]): Buffer {
  const b = Buffer.alloc(24 * list.length);
  list.forEach((n, i) => {
    const o = i * 24;
    b.writeUInt32LE(n.pos, o);
    b.writeUInt16LE(0x4000, o + 4);
    b.writeUInt16LE(n.channel, o + 6);
    b.writeUInt32LE(n.len, o + 8);
    b.writeUInt16LE(n.key, o + 12);
    b[o + 21] = n.vel;
  });
  return b;
}

export function playlist(items: { pos: number; len: number; ref: number; track: number }[]): Buffer {
  const b = Buffer.alloc(60 * items.length);
  items.forEach((it, i) => {
    const o = i * 60;
    b.writeUInt32LE(it.pos, o);
    b.writeUInt16LE(PATTERN_BASE, o + 4);
    b.writeUInt16LE(it.ref, o + 6);
    b.writeUInt32LE(it.len, o + 8);
    b.writeUInt16LE(499 - it.track, o + 12);
  });
  return b;
}

export function fixtureFlp(o: { tempo?: number; extraChannel?: string; bassPlugin?: string; kickSample?: string } = {}): Buffer {
  const w = new FlpWriter();
  w.text(EV.VERSION, "21.2.3.4004", false).dword(EV.TEMPO_FINE, Math.round((o.tempo ?? 140) * 1000)).byte(EV.TIMESIG_NUM, 4).byte(EV.TIMESIG_BEAT, 4);
  w.word(EV.CHAN_NEW, 0).byte(EV.CHAN_TYPE, 0).text(EV.PLUGIN_INTERNAL, "Sampler").text(EV.PLUGIN_NAME, "Kick").text(EV.SAMPLE_PATH, o.kickSample ?? "C:\\Samples\\kick.wav").byte(EV.CHAN_FX, 1);
  w.word(EV.CHAN_NEW, 1).byte(EV.CHAN_TYPE, 2).text(EV.PLUGIN_INTERNAL, o.bassPlugin ?? "Serum").text(EV.PLUGIN_NAME, "Bass").byte(EV.CHAN_FX, 2);
  if (o.extraChannel) w.word(EV.CHAN_NEW, 2).byte(EV.CHAN_TYPE, 2).text(EV.PLUGIN_INTERNAL, "Sytrus").text(EV.PLUGIN_NAME, o.extraChannel).byte(EV.CHAN_FX, 3);
  w.word(EV.PAT_NEW, 1).text(EV.PAT_NAME, "Drop").data(EV.PAT_NOTES, notes([
    { pos: 0, len: 48, key: 36, vel: 100, channel: 0 },
    { pos: 96, len: 48, key: 36, vel: 100, channel: 0 },
    { pos: 0, len: 192, key: 41, vel: 110, channel: 1 },
    { pos: 192, len: 96, key: 44, vel: 90, channel: 1 }
  ]));
  w.word(EV.PAT_NEW, 2).text(EV.PAT_NAME, "Intro").data(EV.PAT_NOTES, notes([{ pos: 0, len: 96, key: 60, vel: 64, channel: 1 }]));
  w.word(EV.ARR_NEW, 0).text(EV.ARR_NAME, "Arrangement").data(EV.PLAYLIST, playlist([
    { pos: 0, len: 384, ref: PATTERN_BASE + 2, track: 0 },
    { pos: 384, len: 768, ref: PATTERN_BASE + 1, track: 1 },
    { pos: 1152, len: 384, ref: PATTERN_BASE + 1, track: 1 }
  ]));
  const insert = (name: string, plugins: string[], routing: number[]) => {
    w.data(EV.INSERT_FLAGS, Buffer.alloc(12));
    plugins.forEach((p, i) => w.text(EV.PLUGIN_INTERNAL, p).word(EV.SLOT_INDEX, i));
    w.text(EV.INSERT_NAME, name);
    const r = Buffer.alloc(8);
    for (const x of routing) r[x] = 1;
    w.data(EV.INSERT_ROUTING, r).dword(EV.INSERT_OUTPUT, 0);
  };
  insert("Master", ["Fruity Limiter"], []);
  insert("Kick Bus", ["Fruity Parametric EQ 2"], [0]);
  insert("Bass Bus", ["Fruity Compressor", "Soundgoodizer"], [0, 3]);
  insert("Reverb", ["Valhalla Room"], [0]);
  return w.build(96);
}

export function zip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = f.store ? f.data : zlib.deflateRawSync(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(f.store ? 0 : 8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(f.store ? 0 : 8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function zipBomb(): Buffer {
  const huge = Buffer.alloc(200 * 1024 ** 2, 0);
  return zip([{ name: "Song/song.xml", data: huge }]);
}

export function fixtureAls(o: { tempo?: number; extraTrack?: string; renameBass?: string; bassDevices?: string[] } = {}): Buffer {
  const track = (kind: string, id: number, name: string, inner: string, devices: string[] = [], sendAmount = "0") => `<${kind} Id="${id}"><Name><EffectiveName Value="${name}"/><UserName Value="${name}"/></Name><Color Value="${id}"/>
<DeviceChain><Mixer><Sends><TrackSendHolder Id="0"><Send><Manual Value="${sendAmount}"/></Send></TrackSendHolder></Sends></Mixer>
<MainSequencer><ClipTimeable><ArrangerAutomation><Events>${inner}</Events></ArrangerAutomation></ClipTimeable></MainSequencer>
<DeviceChain><Devices>${devices.map((d) => (d.startsWith("vst:") ? `<PluginDevice Id="1"><PluginDesc><VstPluginInfo Id="0"><PlugName Value="${d.slice(4)}"/></VstPluginInfo></PluginDesc></PluginDevice>` : `<${d} Id="1"/>`)).join("")}</Devices></DeviceChain></DeviceChain></${kind}>`;
  const midi = `<MidiClip Id="0" Time="0"><CurrentStart Value="0"/><CurrentEnd Value="16"/><Name Value="Bassline"/><Notes><KeyTracks>
<KeyTrack Id="0"><Notes><MidiNoteEvent Time="0" Duration="1" Velocity="100"/><MidiNoteEvent Time="2" Duration="0.5" Velocity="80"/></Notes><MidiKey Value="36"/></KeyTrack>
<KeyTrack Id="1"><Notes><MidiNoteEvent Time="1" Duration="1" Velocity="127"/></Notes><MidiKey Value="43"/></KeyTrack></KeyTracks></Notes></MidiClip>`;
  const audio = `<AudioClip Id="1" Time="16"><CurrentStart Value="16"/><CurrentEnd Value="32"/><Name Value="Vocal chop"/><SampleRef><FileRef><Path Value="C:/Samples/vocal.wav"/></FileRef></SampleRef></AudioClip>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12049" Creator="Ableton Live 12.0.5"><LiveSet><Tracks>
${track("MidiTrack", 1, o.renameBass ?? "Bass", midi, o.bassDevices ?? ["vst:Serum", "Compressor2"], "0.5")}
${track("AudioTrack", 2, "Vocals", audio, ["Eq8", "Reverb"])}
${o.extraTrack ? track("AudioTrack", 3, o.extraTrack, "") : ""}
${track("ReturnTrack", 9, "A-Reverb", "", ["Reverb"])}
</Tracks><MasterTrack><DeviceChain><Mixer><Tempo><Manual Value="${o.tempo ?? 124}"/></Tempo></Mixer></DeviceChain></MasterTrack>
<TimeSignature><TimeSignatures><RemoteableTimeSignature Id="0"><Numerator Value="4"/><Denominator Value="4"/><Time Value="0"/></RemoteableTimeSignature></TimeSignatures></TimeSignature>
<ScaleInformation><RootNote Value="9"/><Name Value="Minor"/></ScaleInformation></LiveSet></Ableton>`;
  return zlib.gzipSync(Buffer.from(xml, "utf8"));
}

export function fixtureRpp(o: { tempo?: number; extraTrack?: string } = {}): Buffer {
  const track = (guid: string, name: string, body: string) => `  <TRACK {${guid}}\n    NAME "${name}"\n${body}  >\n`;
  const text = `<REAPER_PROJECT 0.1 "7.0/win64" 1690000000
  TEMPO ${o.tempo ?? 95} 3 4
${track("A", "Drums", `    <FXCHAIN\n      <VST "VST: ReaEQ (Cockos)" reaeq.dll 0 ""\n      >\n    >\n    <ITEM\n      POSITION 0\n      LENGTH 5.0526\n      NAME "beat.wav"\n      <SOURCE WAVE\n        FILE "C:\\Samples\\beat.wav"\n      >\n    >\n`)}${track("B", "Keys", `    <FXCHAIN\n      <VST "VSTi: Keyscape (Spectrasonics)" keyscape.dll 0 ""\n      >\n    >\n    AUXRECV 0 0 1 0 0 0 0 0 0 -1:U 0 -1 ''\n    <ITEM\n      POSITION 2.5263\n      LENGTH 2.5263\n      NAME "chords"\n      <SOURCE MIDI\n      >\n    >\n`)}${o.extraTrack ? track("C", o.extraTrack, "") : ""}>
`;
  return Buffer.from(text, "utf8");
}

export function fixtureSong(): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Song><Attributes tempo="128" timeSignatureNumerator="4" timeSignatureDenominator="4"/>
<MediaTrack name="Lead" trackID="t1"><List><AudioEvent start="0" length="3.75" name="lead take" url="media://lead.wav"/></List></MediaTrack>
<MusicTrack name="Pads" trackID="t2"><List><NoteEvent start="1.875" length="1.875" name="pad"/></List></MusicTrack></Song>`;
  return zip([{ name: "Song/song.xml", data: Buffer.from(xml) }, { name: "Devices/audiomixer.xml", data: Buffer.from(`<Mixer><AudioTrackChannel label="Lead"><Attributes classID="{x}" name="Pro EQ"/></AudioTrackChannel></Mixer>`) }]);
}

export function fixtureLogicZip(): Buffer {
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>BeatsPerMinute</key><real>92</real><key>SongKey</key><string>D</string><key>SongGenderKey</key><string>minor</string><key>SongSignatureNumerator</key><integer>4</integer><key>SongSignatureDenominator</key><integer>4</integer><key>NumberOfTracks</key><integer>12</integer></dict></plist>`;
  return zip([{ name: "Midnight.logicx/Alternatives/000/MetaData.plist", data: Buffer.from(plist) }, { name: "Midnight.logicx/Alternatives/000/ProjectData", data: Buffer.from([1, 2, 3]) }, { name: "Midnight.logicx/Media/Audio Files/vox.wav", data: Buffer.from("RIFFxxxxWAVE") }]);
}

export function fixtureBitwig(): Buffer {
  return Buffer.concat([Buffer.from("BtWg000100010088000000", "latin1"), Buffer.from("5.1.8 project data")]);
}
