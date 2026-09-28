import zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export const ZIP_LIMITS = { entries: 20000, totalBytes: 4 * 1024 ** 3, ratio: 200, entryBytes: 64 * 1024 ** 2 };

export class ZipRefused extends Error {}

export function safeName(name: string): boolean {
  if (!name || name.includes("\u0000")) return false;
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return false;
  return !n.split("/").some((p) => p === "..");
}

export function listZip(data: Uint8Array): ZipEntry[] {
  if (data.length < 22) throw new ZipRefused("not a zip");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRefused("not a zip");
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirStart = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirStart === 0xffffffff) throw new ZipRefused("zip64 archives are not read");
  if (count > ZIP_LIMITS.entries) throw new ZipRefused("too many files in the zip");
  if (dirStart + dirSize > eocd) throw new ZipRefused("the zip's directory is damaged");
  const decoder = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  let at = dirStart;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) throw new ZipRefused("the zip's directory is damaged");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    if (at + 46 + nameLength > eocd) throw new ZipRefused("the zip's directory is damaged");
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    if (!safeName(name)) throw new ZipRefused(`the zip holds a file with an unsafe name (${name.slice(0, 80)})`);
    total += size;
    if (total > ZIP_LIMITS.totalBytes) throw new ZipRefused("the zip unpacks to more than 4 GB");
    if (size > 0 && compressedSize > 0 && size / compressedSize > ZIP_LIMITS.ratio && size > 10 * 1024 ** 2) throw new ZipRefused("the zip is packed suspiciously tightly");
    if (offset >= data.length) throw new ZipRefused("the zip's directory is damaged");
    out.push({ name, method, compressedSize, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

export function readEntry(data: Uint8Array, e: ZipEntry, maxBytes = ZIP_LIMITS.entryBytes): Buffer {
  if (e.size > maxBytes) throw new ZipRefused(`${e.name} is too large to read`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (e.offset + 30 > data.length || view.getUint32(e.offset, true) !== 0x04034b50) throw new ZipRefused("the zip is damaged");
  const start = e.offset + 30 + view.getUint16(e.offset + 26, true) + view.getUint16(e.offset + 28, true);
  const raw = Buffer.from(data.subarray(start, start + e.compressedSize));
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new ZipRefused(`${e.name} is compressed in a way that isn't supported`);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch {
    throw new ZipRefused(`${e.name} could not be unpacked`);
  }
}

export function gunzipLimited(data: Uint8Array, maxBytes = ZIP_LIMITS.entryBytes): Buffer {
  try {
    return zlib.gunzipSync(data, { maxOutputLength: maxBytes });
  } catch {
    throw new ZipRefused("the file could not be unpacked, or unpacks to too much");
  }
}
