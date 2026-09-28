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
  if (await peaksOf(deps.db, hash)) return;
  const r = await runSandboxed<{ ok: true; durationMs: number; peaks: number[] } | { ok: false; reason: string }>("../audio/worker", { kind: "peaks", file });
  if (!r.ok) return;
  await deps.db.run("INSERT INTO audio_peaks (blob_hash, duration_ms, peaks, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (blob_hash) DO NOTHING", [hash, r.durationMs, JSON.stringify(r.peaks), Date.now()]);
}

async function makePreview(deps: Deps, commitId: string, zips: string[]): Promise<void> {
  const raw = await modelOf(deps.db, commitId);
  const m = Model.safeParse(raw);
  if (!m.success) return;
  const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = path.join(dir, "preview.wav");
    const r = await runSandboxed<{ ok: true; seconds: number } | { ok: false; reason: string }>("../audio/worker", { kind: "render", model: m.data, zips, out });
    if (!r.ok) {
      await deps.db.run("INSERT INTO commit_previews (commit_id, blob_hash, reason, created_at) VALUES (?, NULL, ?, ?) ON CONFLICT (commit_id) DO NOTHING", [commitId, r.reason, Date.now()]);
      return;
    }
    const data = fs.readFileSync(out);
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    await storeOf(deps).putFile(hash, out);
    await deps.db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", [hash, data.length, Date.now()]);
    await deps.db.run("INSERT INTO commit_previews (commit_id, blob_hash, reason, created_at) VALUES (?, ?, '', ?) ON CONFLICT (commit_id) DO NOTHING", [commitId, hash, Date.now()]);
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
      <span class="time mono" aria-live="off">0:00 / ${clock(duration)}</span>
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

export async function tracksFor(deps: Deps, a: Access, c: Commit, files: CommitFile[]): Promise<{ tracks: PlayerTrack[]; kind: "stems" | "bounce" | "preview" | "none"; reason: string }> {
  const base = `${projectPath(a.project)}/c/${c.id}`;
  const stems = files.filter((f) => f.kind === "stem" && f.contentType.startsWith("audio/"));
  const bounce = files.find((f) => f.kind === "bounce" && f.contentType.startsWith("audio/"));
  const build = async (list: CommitFile[]) => {
    const out: PlayerTrack[] = [];
    for (const f of list) {
      const p = await peaksOf(deps.db, f.hash);
      out.push({ name: f.name.replace(/\.(wav|flac|aiff?|mp3)$/i, ""), src: `${base}/f/${f.position}?play=1`, peaks: p?.peaks ?? [], durationMs: p?.durationMs ?? 0 });
    }
    return out;
  };
  if (stems.length) return { tracks: await build(stems), kind: "stems", reason: "" };
  if (bounce) return { tracks: await build([bounce]), kind: "bounce", reason: "" };
  const pv = await deps.db.get<{ blob_hash: string | null; reason: string }>("SELECT blob_hash, reason FROM commit_previews WHERE commit_id = ?", [c.id]);
  if (pv?.blob_hash) {
    const p = await peaksOf(deps.db, pv.blob_hash);
    return { tracks: [{ name: "Preview mix", src: `${base}/preview?play=1`, peaks: p?.peaks ?? [], durationMs: p?.durationMs ?? 0 }], kind: "preview", reason: "" };
  }
  return { tracks: [], kind: "none", reason: pv?.reason ?? "" };
}

export async function listenPanel(deps: Deps, a: Access, c: Commit, files: CommitFile[], title: string, comments?: Html): Promise<Html> {
  const t = await tracksFor(deps, a, c, files);
  if (t.kind === "none") {
    return t.reason ? html`<section class="panel"><h2>${title}</h2><p class="muted">${t.reason}</p></section>` : html``;
  }
  const note = t.kind === "preview" ? html`<p class="muted">A rough mix BeatBranch made from the project's sounds. Effects aren't included.</p>` : t.kind === "bounce" ? html`` : html``;
  return player(t.tracks, { title, note, ...(comments ? { comments } : {}) });
}

const audio: Module = {
  name: "audio",
  register(app, deps) {
    const h = hooks(deps);
    h.lateCommit.push(async (d, _project, commit, files, temps) => {
      for (const f of files) if ((f.kind === "stem" || f.kind === "bounce") && f.contentType.startsWith("audio/")) await makePeaks(d, f.hash, temps.get(f.hash)!);
      if (!files.some((f) => f.kind === "stem" || f.kind === "bounce")) {
        const zips = files.filter((f) => f.kind === "samples" || (f.kind === "project" && f.contentType === "application/zip")).map((f) => temps.get(f.hash)!);
        await makePreview(d, commit.id, zips);
      }
    });
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
      const pv = await deps.db.get<{ blob_hash: string | null }>("SELECT blob_hash FROM commit_previews WHERE commit_id = ?", [c.id]);
      if (!pv?.blob_hash) return reply.callNotFound();
      const url = await storeOf(deps).signedUrl(pv.blob_hash, { filename: `${a.project.slug}-preview.wav`, contentType: "audio/wav", userId: req.user?.id ?? null, ttlSeconds: deps.config.blobUrlTtlSeconds, inline: (req.query as { play?: string }).play === "1" });
      return reply.redirect(url, 303);
    });
  }
};

export default audio;
