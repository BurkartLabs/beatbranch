import { parseAls } from "./als.ts";
import { parseFlp } from "./flp.ts";
import { markBundled, Model, ParseError, type ModelFormat } from "./model.ts";
import { parseRpp } from "./rpp.ts";
import { parseBitwig, parseLogic, parseSong } from "./song.ts";
import { listZip, readEntry, ZipRefused } from "./zip.ts";

export type ParseJob = { daw: string; name: string; project: Uint8Array; samples: Uint8Array | null };
export type ParseResult = { ok: true; model: Model } | { ok: false; reason: string; unsupported?: boolean };

function projectInZip(buf: Uint8Array, daw: string): { format: ModelFormat; data: Uint8Array; bundled: Set<string> } | null {
  const entries = listZip(buf);
  const bundled = new Set(entries.filter((e) => /\.(wav|aif|aiff|flac|mp3|ogg)$/i.test(e.name)).map((e) => e.name));
  if (daw === "logic" || entries.some((e) => /\.logicx\//i.test(e.name))) return { format: "logic", data: buf, bundled };
  const pick = (re: RegExp) => entries.filter((e) => re.test(e.name) && !/(^|\/)(Backup|__MACOSX)\//i.test(e.name)).sort((a, b) => b.size - a.size)[0];
  const flp = pick(/\.flp$/i);
  if (flp) return { format: "flp", data: readEntry(buf, flp, 256 * 1024 ** 2), bundled };
  const als = pick(/\.als$/i);
  if (als) return { format: "als", data: readEntry(buf, als, 256 * 1024 ** 2), bundled };
  const rpp = pick(/\.rpp$/i);
  if (rpp) return { format: "rpp", data: readEntry(buf, rpp, 256 * 1024 ** 2), bundled };
  const song = pick(/\.song$/i);
  if (song) return { format: "song", data: readEntry(buf, song, 512 * 1024 ** 2), bundled };
  if (entries.some((e) => /(^|\/)song\.xml$/i.test(e.name))) return { format: "song", data: buf, bundled };
  const bw = pick(/\.bwproject$/i);
  if (bw) return { format: "bwproject", data: readEntry(buf, bw, 512 * 1024 ** 2), bundled };
  return null;
}

function formatOf(name: string, bytes: Uint8Array): ModelFormat | "zip" | null {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "flp") return "flp";
  if (ext === "als") return "als";
  if (ext === "rpp") return "rpp";
  if (ext === "song") return "song";
  if (ext === "bwproject") return "bwproject";
  if (ext === "zip") return "zip";
  return bytes[0] === 0x50 && bytes[1] === 0x4b ? "zip" : null;
}

export function parseProject(job: ParseJob): ParseResult {
  try {
    let format = formatOf(job.name, job.project);
    let data = job.project;
    let bundled = new Set<string>();
    if (format === "zip") {
      const inner = projectInZip(job.project, job.daw);
      if (!inner) return { ok: false, reason: "The zip doesn't hold a project file BeatBranch can read.", unsupported: true };
      ({ format, data, bundled } = inner);
    }
    if (job.samples) for (const e of listZip(job.samples)) if (/\.(wav|aif|aiff|flac|mp3|ogg)$/i.test(e.name)) bundled.add(e.name);
    let model: Model;
    switch (format) {
      case "flp": model = parseFlp(data, bundled); break;
      case "als": model = parseAls(data); break;
      case "rpp": model = parseRpp(data); break;
      case "song": model = parseSong(data); break;
      case "bwproject": model = parseBitwig(data); break;
      case "logic": model = parseLogic(data); break;
      default: return { ok: false, reason: "BeatBranch can't read this kind of project file yet.", unsupported: true };
    }
    if (format !== "flp" && format !== "logic") model.samples = markBundled(model.samples, bundled);
    const checked = Model.safeParse(model);
    if (!checked.success) return { ok: false, reason: "The project was read, but what came out didn't make sense, so it isn't shown." };
    return { ok: true, model: checked.data };
  } catch (error) {
    if (error instanceof ParseError || error instanceof ZipRefused) return { ok: false, reason: error.message };
    return { ok: false, reason: "The project file couldn't be read." };
  }
}
