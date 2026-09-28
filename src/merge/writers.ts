import zlib from "node:zlib";
import { alsXml, trackName } from "../parsers/als.js";
import { ParseError } from "../parsers/model.js";
import { parseBlocks, trackNameOf } from "../parsers/rpp.js";
import { child, parseXml } from "../parsers/xml.js";

export type Pick = { source: "main" | "idea"; name: string };

export interface TrackChoice {
  name: string;
  inMain: boolean;
  inIdea: boolean;
}

function alsTracks(buf: Uint8Array) {
  const src = alsXml(buf);
  const root = parseXml(src);
  const tracks = child(child(child(root, "Ableton"), "LiveSet"), "Tracks");
  if (!tracks) throw new ParseError("not an Ableton Live set");
  return { src, tracks, list: tracks.children.map((t) => ({ el: t, name: trackName(t), kind: t.name, raw: src.slice(t.start, t.end) })) };
}

function rppTracks(buf: Uint8Array) {
  const src = Buffer.from(buf).toString("utf8").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const project = parseBlocks(src).blocks.find((b) => b.head === "REAPER_PROJECT");
  if (!project) throw new ParseError("not a Reaper project");
  const list = project.blocks.filter((b) => b.head === "TRACK").map((b) => ({ name: trackNameOf(b), start: b.startLine, end: b.endLine, raw: lines.slice(b.startLine, b.endLine + 1).join("\n") }));
  return { lines, list };
}

export function choicesFor(format: "als" | "rpp", main: Uint8Array, idea: Uint8Array): TrackChoice[] {
  const names = (b: Uint8Array) => (format === "als" ? alsTracks(b).list.filter((t) => t.kind !== "ReturnTrack").map((t) => t.name) : rppTracks(b).list.map((t) => t.name));
  const m = names(main);
  const i = names(idea);
  const out: TrackChoice[] = m.map((n) => ({ name: n, inMain: true, inIdea: i.includes(n) }));
  for (const n of i) if (!m.includes(n)) out.push({ name: n, inMain: false, inIdea: true });
  return out;
}

export function mergeAls(main: Uint8Array, idea: Uint8Array, picks: Pick[]): Buffer {
  const M = alsTracks(main);
  const I = alsTracks(idea);
  const returns = M.list.filter((t) => t.kind === "ReturnTrack");
  const chosen: string[] = [];
  const usedIds = new Set<string>();
  let nextId = 900000;
  for (const p of picks) {
    const from = (p.source === "main" ? M : I).list.find((t) => t.kind !== "ReturnTrack" && t.name === p.name);
    if (!from) throw new ParseError(`the instrument “${p.name}” isn't in that version`);
    let raw = from.raw;
    const id = from.el.attrs.Id;
    if (id !== undefined && usedIds.has(id)) {
      raw = raw.replace(/^(<\w+\s+Id=")[^"]*"/, `$1${String(nextId++)}"`);
    } else if (id !== undefined) usedIds.add(id);
    chosen.push(raw);
  }
  for (const r of returns) chosen.push(r.raw);
  const open = M.src.indexOf(">", M.tracks.start) + 1;
  const close = M.src.lastIndexOf("</Tracks>", M.tracks.end);
  const out = `${M.src.slice(0, open)}\n${chosen.join("\n")}\n${M.src.slice(close)}`;
  return zlib.gzipSync(Buffer.from(out, "utf8"));
}

export function mergeRpp(main: Uint8Array, idea: Uint8Array, picks: Pick[]): Buffer {
  const M = rppTracks(main);
  const I = rppTracks(idea);
  const chosen: string[] = [];
  for (const p of picks) {
    const from = (p.source === "main" ? M : I).list.find((t) => t.name === p.name);
    if (!from) throw new ParseError(`the track “${p.name}” isn't in that version`);
    chosen.push(from.raw);
  }
  if (!M.list.length) {
    const end = M.lines.lastIndexOf(">");
    return Buffer.from([...M.lines.slice(0, end), ...chosen, ...M.lines.slice(end)].join("\n"), "utf8");
  }
  const first = M.list[0]!.start;
  const last = M.list[M.list.length - 1]!.end;
  return Buffer.from([...M.lines.slice(0, first), ...chosen, ...M.lines.slice(last + 1)].join("\n"), "utf8");
}
