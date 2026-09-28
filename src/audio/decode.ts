import { spawn } from "node:child_process";

export const PEAK_BUCKETS = 1200;
export const RATE = 22050;

export interface Pcm {
  rate: number;
  channels: Float32Array[];
}

export class DecodeError extends Error {}

function ascii(b: Buffer, o: number, n: number) {
  return b.toString("latin1", o, o + n);
}

export function decodeWav(b: Buffer): Pcm {
  if (b.length < 12 || (ascii(b, 0, 4) !== "RIFF" && ascii(b, 0, 4) !== "RF64") || ascii(b, 8, 4) !== "WAVE") throw new DecodeError("not a WAV file");
  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    let size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > b.length) throw new DecodeError("the WAV's format block is damaged");
      let format = b.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new DecodeError("the WAV has no format block");
      if (size === 0xffffffff || body + size > b.length) size = b.length - body;
      const { format, channels, rate, bits } = fmt;
      if (channels < 1 || channels > 64 || rate < 1000 || rate > 768000) throw new DecodeError("the WAV's format is out of range");
      const bytes = bits / 8;
      if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && (bits === 32 || bits === 64))) throw new DecodeError("the WAV's sample format isn't supported");
      const frames = Math.floor(size / (bytes * channels));
      const out = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          const o = body + (f * channels + c) * bytes;
          let v: number;
          if (format === 3) v = bits === 32 ? b.readFloatLE(o) : b.readDoubleLE(o);
          else if (bits === 8) v = (b[o]! - 128) / 128;
          else if (bits === 16) v = b.readInt16LE(o) / 32768;
          else if (bits === 24) v = b.readIntLE(o, 3) / 8388608;
          else v = b.readInt32LE(o) / 2147483648;
          out[c]![f] = v;
        }
      }
      return { rate, channels: out };
    }
    at = body + size + (size % 2);
  }
  throw new DecodeError("the WAV has no audio");
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export function decodeWithFfmpeg(file: string, seconds = 60, maxSeconds = 1800, rate = RATE): Promise<Pcm> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-t", String(maxSeconds), "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"];
    const p = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = maxSeconds * rate * 4 + 1024;
    const timer = setTimeout(() => p.kill("SIGKILL"), seconds * 1000);
    p.stdout.on("data", (c: Buffer) => {
      total += c.length;
      if (total > cap) p.kill("SIGKILL");
      else chunks.push(c);
    });
    p.stderr.resume();
    p.on("error", () => {
      clearTimeout(timer);
      reject(new DecodeError("audio decoding isn't available on this server"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || total === 0) return reject(new DecodeError("the audio file couldn't be decoded"));
      const buf = Buffer.concat(chunks);
      const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      resolve({ rate, channels: [Float32Array.from(f)] });
    });
  });
}

export const VORBIS_IN_WAV = new Set([0x674f, 0x6750, 0x6751, 0x676f, 0x6770, 0x6771]);

export function wavFormat(b: Buffer): number | null {
  if (b.length < 12 || (ascii(b, 0, 4) !== "RIFF" && ascii(b, 0, 4) !== "RF64") || ascii(b, 8, 4) !== "WAVE") return null;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "fmt " && at + 10 <= b.length) {
      const f = b.readUInt16LE(at + 8);
      return f === 0xfffe && at + 8 + 26 <= b.length ? b.readUInt16LE(at + 8 + 24) : f;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

export function oggInsideWav(b: Buffer): Buffer | null {
  const f = wavFormat(b);
  if (f === null || !VORBIS_IN_WAV.has(f)) return null;
  const i = b.indexOf("data", 12, "latin1");
  if (i < 0) return null;
  const d = b.subarray(i + 8);
  const o = d.indexOf("OggS", 0, "latin1");
  return o >= 0 ? d.subarray(o) : null;
}

export function browserSafe(b: Buffer): boolean {
  const f = wavFormat(b);
  if (f !== null) return f === 1 || f === 3;
  if (ascii(b, 0, 4) === "fLaC") return true;
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return true;
  return false;
}

export function transcodeToWav(input: string, output: string, seconds = 120): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-map_metadata", "-1", "-c:a", "pcm_s16le", "-f", "wav", output], { stdio: "ignore", windowsHide: true });
    const t = setTimeout(() => p.kill("SIGKILL"), seconds * 1000);
    p.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

export async function decodeAny(file: string, head: Buffer, read: () => Buffer): Promise<Pcm> {
  if (ascii(head, 0, 4) === "RIFF" || ascii(head, 0, 4) === "RF64") {
    try {
      return decodeWav(read());
    } catch (e) {
      if (!(e instanceof DecodeError) || !/sample format/.test(e.message)) throw e;
    }
  }
  return decodeWithFfmpeg(file);
}

export function peaks(pcm: Pcm, buckets = PEAK_BUCKETS): { durationMs: number; peaks: number[] } {
  const frames = pcm.channels[0]?.length ?? 0;
  const n = Math.max(1, Math.min(buckets, frames));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor((i * frames) / n);
    const e = Math.max(s + 1, Math.floor(((i + 1) * frames) / n));
    let lo = 0;
    let hi = 0;
    for (const ch of pcm.channels) {
      for (let f = s; f < e && f < frames; f++) {
        const v = ch[f]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out.push(Math.round(Math.max(-1, lo) * 127), Math.round(Math.min(1, hi) * 127));
  }
  return { durationMs: Math.round((frames / pcm.rate) * 1000), peaks: out };
}

export function encodeWav(channels: Float32Array[], rate: number): Buffer {
  const frames = channels[0]?.length ?? 0;
  const nc = channels.length;
  const data = Buffer.alloc(frames * nc * 2);
  for (let f = 0; f < frames; f++) for (let c = 0; c < nc; c++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(channels[c]![f]! * 32767))), (f * nc + c) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(nc, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * nc * 2, 28);
  h.writeUInt16LE(nc * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
