import { emptyModel, ParseError, uniqueSamples, type Clip, type Model, type Track } from "./model.ts";

export interface Block {
  head: string;
  tokens: string[];
  lines: { text: string; tokens: string[] }[];
  blocks: Block[];
  startLine: number;
  endLine: number;
}

export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /\s*("([^"]*)"|'([^']*)'|`([^`]*)`|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}

export function parseBlocks(src: string): Block {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 5_000_000) throw new ParseError("the file is too long");
  const root: Block = { head: "#root", tokens: [], lines: [], blocks: [], startLine: 0, endLine: lines.length - 1 };
  const stack: Block[] = [root];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const top = stack[stack.length - 1]!;
    if (line.startsWith("<")) {
      const tokens = tokenize(line.slice(1));
      const b: Block = { head: tokens[0] ?? "", tokens, lines: [], blocks: [], startLine: i, endLine: i };
      top.blocks.push(b);
      stack.push(b);
      if (stack.length > 200) throw new ParseError("the file nests too deeply");
    } else if (line === ">") {
      if (stack.length === 1) throw new ParseError("the file closes a block it never opened");
      stack.pop()!.endLine = i;
    } else top.lines.push({ text: line, tokens: tokenize(line) });
  });
  if (stack.length !== 1) throw new ParseError("the file ends before its blocks close");
  return root;
}

const get = (b: Block, key: string) => b.lines.find((l) => l.tokens[0] === key)?.tokens ?? null;

export function trackNameOf(t: Block): string {
  return get(t, "NAME")?.[1] ?? "";
}

export function parseRpp(buf: Uint8Array): Model {
  const src = Buffer.from(buf).toString("utf8");
  const root = parseBlocks(src);
  const project = root.blocks.find((b) => b.head === "REAPER_PROJECT");
  if (!project) throw new ParseError("not a Reaper project");
  const m = emptyModel("rpp", `Reaper ${project.tokens[2] ?? ""}`.trim());
  const tempo = get(project, "TEMPO");
  if (tempo) {
    const bpm = Number(tempo[1]);
    if (bpm > 0) m.tempo = bpm;
    const num = Number(tempo[2]);
    const den = Number(tempo[3]);
    if (num > 0 && den > 0) m.timeSignature = [num, den];
  }
  const bps = (m.tempo ?? 120) / 60;
  const samples: string[] = [];
  const tracks = project.blocks.filter((b) => b.head === "TRACK");
  const names = tracks.map((t, i) => trackNameOf(t) || `Track ${i + 1}`);
  m.tracks = tracks.map((t, i): Track => {
    const fx = t.blocks.find((b) => b.head === "FXCHAIN");
    const plugins = (fx?.blocks ?? [])
      .filter((b) => ["VST", "VST3", "AU", "JS", "CLAP", "DX"].includes(b.head))
      .map((b) => (b.tokens[1] ?? b.head).replace(/^(VSTi?|VST3i?|AUi?|CLAPi?|JS):\s*/, "").replace(/\s*\([^)]*\)\s*$/, ""));
    const sends = t.lines.filter((l) => l.tokens[0] === "AUXRECV").map((l) => Number(l.tokens[1])).filter((n) => Number.isInteger(n) && n >= 0 && n < names.length);
    const clips: Clip[] = t.blocks
      .filter((b) => b.head === "ITEM")
      .map((it) => {
        const pos = Number(get(it, "POSITION")?.[1] ?? 0);
        const len = Number(get(it, "LENGTH")?.[1] ?? 0);
        const source = it.blocks.find((b) => b.head === "SOURCE");
        const file = source ? get(source, "FILE")?.[1] ?? null : null;
        if (file) samples.push(file);
        const midi = source?.tokens[1] === "MIDI";
        return { start: pos * bps, length: len * bps, name: get(it, "NAME")?.[1] ?? (file ? file.split(/[\\/]/).pop()! : "Item"), kind: midi ? "midi" : "audio", pattern: null, sample: file } satisfies Clip;
      })
      .sort((a, b) => a.start - b.start);
    return { id: t.tokens[1] ?? String(i), name: names[i]!, kind: clips.some((c) => c.kind === "midi") ? "midi" : clips.length ? "audio" : "other", color: null, plugins, mixer: i, sends: sends.map((s) => names[s]!), clips };
  });
  for (let i = 0; i < m.tracks.length; i++) {
    for (const s of m.tracks[i]!.sends) {
      const target = m.tracks.findIndex((t) => t.name === s);
      void target;
    }
  }
  m.mixer = m.tracks.map((t, i) => ({ index: i, name: t.name, plugins: t.plugins, sends: [] as number[] }));
  m.tracks.forEach((t, i) => {
    tracks[i]!.lines.filter((l) => l.tokens[0] === "AUXRECV").forEach((l) => {
      const src = Number(l.tokens[1]);
      if (m.mixer[src]) m.mixer[src]!.sends.push(i);
    });
    void t;
  });
  for (const t of m.tracks) t.sends = [];
  m.mixer.forEach((mc, i) => (m.tracks[i]!.sends = mc.sends.map((s) => m.tracks[s]!.name)));
  m.samples = uniqueSamples(samples);
  m.lengthBeats = Math.max(0, ...m.tracks.flatMap((t) => t.clips.map((c) => c.start + c.length)));
  return m;
}
