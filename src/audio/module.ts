import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Deps, Module } from "../app.js";
import { storeOf } from "../commits/module.js";
import { filesOf, getCommit, modelOf, type Commit, type CommitFile } from "../commits/repo.js";
import type { Db } from "../db/db.js";
import { hooks } from "../hooks.js";
import { Model } from "../parsers/model.js";
import { runSandboxed } from "../parsers/run.js";
import { access, type Access } from "../projects/repo.js";
import { z } from "zod";
import { commentsFor } from "../social/comments.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80), id: z.string().max(40) });
import { projectPath } from "../projects/views.js";
import { html, type Html } from "../web/html.js";

export async function peaksOf(db: Db, hash: string): Promise<{ durationMs: number; peaks: number[] } | null> {
  const r = await db.get<{ duration_ms: number; peaks: number[] }>("SELECT duration_ms, peaks FROM audio_peaks WHERE blob_hash = ?", [hash]);
  return r ? { durationMs: Number(r.duration_ms), peaks: r.peaks } : null;
}

export async function makePeaks(deps: Deps, hash: string, file: string): Promise<void> {
  if ((await peaksOf(deps.db, hash)) && (await deps.db.get("SELECT 1 AS x FROM audio_playable WHERE blob_hash = ?", [hash]))) return;
  const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = path.join(dir, "playable.wav");
    const r = await runSandboxed<{ ok: true; transcoded: boolean; durationMs: number; peaks: number[] } | { ok: false; reason: string }>("../audio/worker", { kind: "prepare", file, out });
    if (!r.ok) {
      await deps.db.run("INSERT INTO audio_playable (blob_hash, playable_hash, reason, created_at) VALUES (?, NULL, ?, ?) ON CONFLICT (blob_hash) DO UPDATE SET playable_hash = NULL, reason = EXCLUDED.reason", [hash, r.reason, Date.now()]);
      return;
    }
    let playable = hash;
    if (r.transcoded) {
      const data = fs.readFileSync(out);
      playable = crypto.createHash("sha256").update(data).digest("hex");
      await storeOf(deps).putFile(playable, out);
      await deps.db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", [playable, data.length, Date.now()]);
    }
    await deps.db.run("INSERT INTO audio_playable (blob_hash, playable_hash, reason, created_at) VALUES (?, ?, '', ?) ON CONFLICT (blob_hash) DO UPDATE SET playable_hash = EXCLUDED.playable_hash, reason = ''", [hash, playable, Date.now()]);
    await deps.db.run("INSERT INTO audio_peaks (blob_hash, duration_ms, peaks, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (blob_hash) DO UPDATE SET duration_ms = EXCLUDED.duration_ms, peaks = EXCLUDED.peaks", [hash, r.durationMs, JSON.stringify(r.peaks), Date.now()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function playableOf(db: Db, hash: string): Promise<{ hash: string | null; reason: string } | null> {
  const r = await db.get<{ playable_hash: string | null; reason: string }>("SELECT playable_hash, reason FROM audio_playable WHERE blob_hash = ?", [hash]);
  return r ? { hash: r.playable_hash, reason: r.reason } : null;
}

const SHORT_MS = 3000;
const isShort = (ms: number) => ms > 0 && ms < SHORT_MS;

export async function prepareListening(deps: Deps, commitId: string, files: Pick<CommitFile, "kind" | "name" | "hash" | "contentType">[], local: Map<string, string>): Promise<void> {
  const audio = files.filter((f) => (f.kind === "stem" || f.kind === "bounce") && f.contentType.startsWith("audio/"));
  for (const f of audio) await makePeaks(deps, f.hash, local.get(f.hash)!);
  if (files.some((f) => f.kind === "bounce")) return;
  const stems = files.filter((f) => f.kind === "stem");
  const lengths = (await Promise.all(stems.map((f) => peaksOf(deps.db, f.hash)))).flatMap((p) => (p ? [p.durationMs] : []));
  if (lengths.some((ms) => !isShort(ms))) return;
  const zips = files.filter((f) => f.kind === "samples" || (f.kind === "project" && f.contentType === "application/zip")).map((f) => local.get(f.hash)!);
  await makePreview(deps, commitId, zips, stems.map((f) => ({ name: f.name, file: local.get(f.hash)! })));
}

export async function makePreview(deps: Deps, commitId: string, zips: string[], sounds: { name: string; file: string }[] = []): Promise<void> {
  const raw = await modelOf(deps.db, commitId);
  const m = Model.safeParse(raw);
  if (!m.success) return;
  const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = path.join(dir, "preview.wav");
    const r = await runSandboxed<{ ok: true; seconds: number; standIns: string[]; missing: string[]; contentType: string } | { ok: false; reason: string }>("../audio/worker", { kind: "render", model: m.data, zips, sounds, out }, { memoryMb: 768, seconds: 120 });
    if (!r.ok) {
      await deps.db.run("INSERT INTO commit_previews (commit_id, blob_hash, reason, created_at) VALUES (?, NULL, ?, ?) ON CONFLICT (commit_id) DO UPDATE SET blob_hash = NULL, reason = EXCLUDED.reason", [commitId, r.reason, Date.now()]);
      return;
    }
    const data = fs.readFileSync(out);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    await storeOf(deps).putFile(hash, out);
    await deps.db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", [hash, data.length, Date.now()]);
    await deps.db.run(
      "INSERT INTO commit_previews (commit_id, blob_hash, reason, content_type, stand_ins, missing, created_at) VALUES (?, ?, '', ?, ?, ?, ?) ON CONFLICT (commit_id) DO UPDATE SET blob_hash = EXCLUDED.blob_hash, reason = '', content_type = EXCLUDED.content_type, stand_ins = EXCLUDED.stand_ins, missing = EXCLUDED.missing",
      [commitId, hash, r.contentType, JSON.stringify(r.standIns), JSON.stringify(r.missing), Date.now()]
    );
    await makePeaks(deps, hash, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface PlayerTrack {
  name: string;
  src: string;
  peaks: number[];
  durationMs: number;
}

export function player(tracks: PlayerTrack[], options: { title: string; mode?: "mix" | "ab"; id?: string; comments?: Html; note?: Html } = { title: "Listen" }): Html {
  if (!tracks.length) return html``;
  const mode = options.mode ?? "mix";
  const duration = Math.max(...tracks.map((t) => t.durationMs));
  return html`<section class="panel player" data-player data-mode="${mode}"${options.id ? html` id="${options.id}"` : ""} data-duration="${String(duration)}">
  <div class="row space"><h2>${options.title}</h2>
    <div class="transport">
      <button class="button primary play" type="button" aria-label="Play">Play</button>
      <span class="time mono" aria-live="off">${duration < 10000 ? `0.0s / ${(duration / 1000).toFixed(1)}s` : `0:00 / ${clock(duration)}`}</span>
      ${mode === "ab" ? html`<span class="ab" role="group" aria-label="Which version to hear"><button class="button ab-a" type="button" aria-pressed="true">A: before</button><button class="button ab-b" type="button" aria-pressed="false">B: after</button></span>` : ""}
      <label class="master-label">Volume <input class="master" type="range" min="0" max="1" step="0.01" value="0.9" aria-label="Volume for everything"></label>
    </div>
  </div>
  ${options.note ?? ""}
  <ul class="stems">${tracks.map((t, i) => html`<li class="stem" data-src="${t.src}" data-peaks="${JSON.stringify(t.peaks)}" data-duration="${String(t.durationMs)}" data-index="${String(i)}">
    <span class="stem-name">${t.name}</span>
    ${mode === "mix" && tracks.length > 1 ? html`<button class="button quiet mute" type="button" aria-pressed="false" title="Silence this one">Mute</button><button class="button quiet solo" type="button" aria-pressed="false" title="Hear only this one">Solo</button>` : ""}
    <canvas class="wave" width="1200" height="56" aria-hidden="true"></canvas>
  </li>`)}</ul>
  ${options.comments ?? ""}
  <noscript><p class="muted">Turn on JavaScript to listen here, or download the files below.</p></noscript>
</section>`;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export async function tracksFor(deps: Deps, a: Access, c: Commit, files: CommitFile[]): Promise<{ tracks: PlayerTrack[]; kind: "stems" | "bounce" | "preview" | "none"; reason: string; standIns: string[]; missing: string[] }> {
  const base = `${projectPath(a.project)}/c/${c.id}`;
  const stems = files.filter((f) => f.kind === "stem" && f.contentType.startsWith("audio/"));
  const bounce = files.find((f) => f.kind === "bounce" && f.contentType.startsWith("audio/"));
  const unplayable: string[] = [];
  const build = async (list: CommitFile[]) => {
    const out: PlayerTrack[] = [];
    for (const f of list) {
      const play = await playableOf(deps.db, f.hash);
      if (play && !play.hash) {
        unplayable.push(f.name);
        continue;
      }
      const p = await peaksOf(deps.db, f.hash);
      out.push({ name: f.name.replace(/\.(wav|flac|aiff?|mp3)$/i, ""), src: `${base}/f/${f.position}?play=1`, peaks: p?.peaks ?? [], durationMs: p?.durationMs ?? 0 });
    }
    return out;
  };
  const cant = () => (unplayable.length ? `BeatBranch can't play ${unplayable.join(", ")}: ${unplayable.length === 1 ? "it's" : "they're"} in a format browsers don't understand.` : "");
  const none = { standIns: [], missing: [] };
  const stemTracks = stems.length ? await build(stems) : [];
  if (stemTracks.length && !stemTracks.every((t) => isShort(t.durationMs))) return { tracks: stemTracks, kind: "stems", reason: cant(), ...none };
  if (bounce) {
    const tracks = await build([bounce]);
    if (tracks.length) return { tracks, kind: "bounce", reason: cant(), ...none };
  }
  const pv = await deps.db.get<{ blob_hash: string | null; reason: string; stand_ins: string; missing: string }>("SELECT blob_hash, reason, stand_ins, missing FROM commit_previews WHERE commit_id = ?", [c.id]);
  if (pv?.blob_hash) {
    const p = await peaksOf(deps.db, pv.blob_hash);
    return { tracks: [{ name: "The song", src: `${base}/preview?play=1`, peaks: p?.peaks ?? [], durationMs: p?.durationMs ?? 0 }], kind: "preview", reason: "", standIns: JSON.parse(pv.stand_ins) as string[], missing: JSON.parse(pv.missing) as string[] };
  }
  if (stemTracks.length) return { tracks: stemTracks, kind: "stems", reason: cant(), ...none };
  if (unplayable.length) return { tracks: [], kind: "none", reason: cant(), ...none };
  return { tracks: [], kind: "none", reason: pv?.reason ?? "", ...none };
}

function list(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export async function listenPanel(deps: Deps, a: Access, c: Commit, files: CommitFile[], title: string, comments?: Html): Promise<Html> {
  const t = await tracksFor(deps, a, c, files);
  if (t.kind === "none") {
    return t.reason ? html`<section class="panel"><h2>${title}</h2><p class="muted">${t.reason}</p></section>` : html``;
  }
  const short = t.kind === "stems" && t.tracks.every((x) => isShort(x.durationMs));
  const daw = a.project.daw === "fl-studio" ? "FL Studio" : "your music program";
  const one = t.standIns.length === 1;
  const preview = html`<p class="muted">BeatBranch played this from the project file${t.standIns.length ? `, so it's a sketch. ${list(t.standIns)} ${one ? "uses a simple stand-in sound" : "use simple stand-in sounds"}, because only ${daw} can play ${one ? "that instrument" : "those instruments"}` : ""}. Effects aren't included. To hear exactly what you hear in ${daw}, add the full song to a save.</p>${t.missing.length ? html`<p class="muted">Missing sound${t.missing.length === 1 ? "" : "s"}: ${list(t.missing)}. Add ${t.missing.length === 1 ? "it" : "them"} to the samples zip to hear ${t.missing.length === 1 ? "it" : "them"}.</p>` : ""}`;
  const note = html`${t.kind === "preview" ? preview : ""}${short ? html`<p class="flash ok">These instrument tracks are only a few seconds long, so they sound like single sounds, not parts of the song. To hear the whole song here, export it from your music program${a.project.daw === "fl-studio" ? " (in FL Studio: File › Export › WAV file; tick “Split mixer tracks” to get one file per instrument)" : ""} and save a new version with those files.</p>` : ""}${t.reason ? html`<p class="muted">${t.reason}</p>` : ""}`;
  return player(t.tracks, { title, note, ...(comments ? { comments } : {}) });
}

const audio: Module = {
  name: "audio",
  register(app, deps) {
    const h = hooks(deps);
    h.lateCommit.push(async (d, _project, commit, files, temps) => prepareListening(d, commit.id, files, temps));
    h.commitExtras.unshift(async (d, a, c, files, _audio, req) => listenPanel(d, a, c, files, "Listen to this save", await commentsFor(d, a, c, req)));
    h.branchPanels.unshift(async (d, a, branch) => {
      if (!branch.headCommitId) return html``;
      const c = await getCommit(d.db, a.project.id, branch.headCommitId);
      if (!c) return html``;
      return listenPanel(d, a, c, await filesOf(d.db, c.id), "Listen");
    });

    app.get("/p/@:handle/:slug/c/:id/preview", { config: { public: true } }, async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const c = await getCommit(deps.db, a.project.id, p.id);
      if (!c) return reply.callNotFound();
      const pv = await deps.db.get<{ blob_hash: string | null; content_type: string }>("SELECT blob_hash, content_type FROM commit_previews WHERE commit_id = ?", [c.id]);
      if (!pv?.blob_hash) return reply.callNotFound();
      const url = await storeOf(deps).signedUrl(pv.blob_hash, { filename: `${a.project.slug}-song.${pv.content_type === "audio/mpeg" ? "mp3" : "wav"}`, contentType: pv.content_type, userId: req.user?.id ?? null, ttlSeconds: deps.config.blobUrlTtlSeconds, inline: (req.query as { play?: string }).play === "1" });
      return reply.redirect(url, 303);
    });
  }
};

export default audio;
