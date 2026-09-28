import fs from "node:fs";
import path from "node:path";
import type { DawId } from "../projects/catalogue.js";

export type FileKind = "project" | "stem" | "bounce" | "samples";
export type Format = "flp" | "als" | "rpp" | "song" | "bwproject" | "zip" | "wav" | "flac" | "aiff" | "mp3";

export const MAX_FILE_BYTES = 1024 ** 3;
export const MAX_STEMS = 64;

export const FORMAT_TYPE: Record<Format, string> = {
  flp: "application/octet-stream",
  als: "application/gzip",
  rpp: "text/plain",
  song: "application/zip",
  bwproject: "application/octet-stream",
  zip: "application/zip",
  wav: "audio/wav",
  flac: "audio/flac",
  aiff: "audio/aiff",
  mp3: "audio/mpeg"
};

const PROJECT_FORMATS: Record<DawId, Format[]> = {
  "fl-studio": ["flp", "zip"],
  ableton: ["als", "zip"],
  logic: ["zip"],
  reaper: ["rpp", "zip"],
  "studio-one": ["song", "zip"],
  bitwig: ["bwproject", "zip"],
  other: ["flp", "als", "rpp", "song", "bwproject", "zip"]
};

const KIND_FORMATS: Record<Exclude<FileKind, "project">, Format[]> = {
  stem: ["wav", "flac", "aiff"],
  bounce: ["wav", "flac", "aiff", "mp3"],
  samples: ["zip"]
};

export function allowedFormats(kind: FileKind, daw: DawId): Format[] {
  return kind === "project" ? PROJECT_FORMATS[daw] : KIND_FORMATS[kind];
}

const EXT: Record<string, Format> = {
  ".flp": "flp", ".als": "als", ".rpp": "rpp", ".song": "song", ".bwproject": "bwproject", ".zip": "zip",
  ".wav": "wav", ".wave": "wav", ".flac": "flac", ".aif": "aiff", ".aiff": "aiff", ".mp3": "mp3"
};

export function formatFromName(name: string): Format | null {
  return EXT[path.extname(name).toLowerCase()] ?? null;
}

const at = (b: Uint8Array, offset: number, text: string) => text.split("").every((c, i) => b[offset + i] === c.charCodeAt(0));

export function formatFromBytes(b: Uint8Array): Format | null {
  if (at(b, 0, "FLhd")) return "flp";
  if (b[0] === 0x1f && b[1] === 0x8b) return "als";
  if (at(b, 0, "<REAPER_PROJECT")) return "rpp";
  if (at(b, 0, "PK\u0003\u0004") || at(b, 0, "PK\u0005\u0006")) return "zip";
  if (at(b, 0, "BtWg")) return "bwproject";
  if (at(b, 0, "RIFF") && at(b, 8, "WAVE")) return "wav";
  if (at(b, 0, "RF64") && at(b, 8, "WAVE")) return "wav";
  if (at(b, 0, "fLaC")) return "flac";
  if (at(b, 0, "FORM") && (at(b, 8, "AIFF") || at(b, 8, "AIFC"))) return "aiff";
  if (at(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  return null;
}

export function head(file: string, bytes = 32): Uint8Array {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export type Judged = { ok: true; format: Format; contentType: string } | { ok: false; reason: string };

export function judge(kind: FileKind, daw: DawId, name: string, file: string): Judged {
  const claimed = formatFromName(name);
  const allowed = allowedFormats(kind, daw);
  if (!claimed || !allowed.includes(claimed)) return { ok: false, reason: `${name}: expected ${allowed.map((f) => `.${f === "aiff" ? "aif" : f}`).join(", ")}.` };
  const found = formatFromBytes(head(file));
  const same = found === claimed || (claimed === "song" && found === "zip");
  if (!same) return { ok: false, reason: `${name} is not a real .${claimed} file.` };
  return { ok: true, format: claimed, contentType: FORMAT_TYPE[claimed] };
}

export function cleanName(name: string): string {
  const base = path.basename(String(name).replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "_").trim();
  const trimmed = base.length > 180 ? base.slice(0, 120) + base.slice(-60) : base;
  return trimmed || "file";
}
