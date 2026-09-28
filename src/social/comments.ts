import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Deps } from "../app.js";
import { clock } from "../audio/module.js";
import type { Commit } from "../commits/repo.js";
import type { Db } from "../db/db.js";
import type { Access } from "../projects/repo.js";
import { dayOf, projectPath } from "../projects/views.js";
import { html, type Html } from "../web/html.js";

export interface Comment {
  id: string;
  authorHandle: string | null;
  authorName: string | null;
  body: string;
  atMs: number | null;
  createdAt: number;
}

export async function listComments(db: Db, commitId: string): Promise<Comment[]> {
  const rows = await db.all<{ id: string; handle: string | null; display_name: string | null; body: string; at_ms: number | null; created_at: number }>(
    "SELECT c.id, u.handle, u.display_name, c.body, c.at_ms, c.created_at FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.commit_id = ? ORDER BY COALESCE(c.at_ms, -1), c.created_at",
    [commitId]
  );
  return rows.map((r) => ({ id: r.id, authorHandle: r.handle, authorName: r.display_name, body: r.body, atMs: r.at_ms === null ? null : Number(r.at_ms), createdAt: Number(r.created_at) }));
}

export async function addComment(db: Db, projectId: string, commitId: string, authorId: string, body: string, atMs: number | null): Promise<void> {
  await db.run("INSERT INTO comments (id, project_id, commit_id, author_id, body, at_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), projectId, commitId, authorId, body, atMs, Date.now()]);
}

export async function commentsFor(deps: Deps, a: Access, c: Commit, req: FastifyRequest): Promise<Html> {
  const list = await listComments(deps.db, c.id);
  const canComment = !!req.user && a.role !== null;
  const base = `${projectPath(a.project)}/c/${c.id}`;
  const timed = list.filter((x) => x.atMs !== null);
  return html`<div class="comments">
  ${timed.length ? html`<div class="markers" aria-label="Comments on the timeline">${timed.map((x) => html`<button type="button" class="marker" data-at="${String(x.atMs)}" title="${x.authorName ?? "someone"}: ${x.body.slice(0, 80)}">${clock(x.atMs!)}</button>`)}</div>` : ""}
  <h3>Comments</h3>
  ${list.length ? html`<ol class="comment-list">${list.map((x) => html`<li class="comment"><p class="muted">${x.authorHandle ? html`<a href="/@${x.authorHandle}">${x.authorName}</a>` : "someone"} · ${dayOf(x.createdAt)}${x.atMs !== null ? html` · at <button type="button" class="linkish seek" data-at="${String(x.atMs)}">${clock(x.atMs)}</button>` : ""}</p><p class="comment-body">${x.body}</p></li>`)}</ol>` : html`<p class="muted">No comments yet.</p>`}
  ${canComment ? html`<form method="post" action="${base}/comments" class="comment-form">
    <input type="hidden" name="_csrf" value="${req.session!.csrfToken}">
    <label for="comment-body">Say something about this save</label>
    <textarea id="comment-body" name="body" required maxlength="2000"></textarea>
    <label class="choice"><input type="checkbox" name="timed" value="1" class="timed"><span>At <input type="text" name="at" class="at-input" value="0:00" inputmode="numeric" maxlength="8" aria-label="Time in the song"> in the song</span></label>
    <div class="actions"><button class="button primary" type="submit">Post comment</button></div>
  </form>` : req.user ? html`<p class="muted">Only people on this song can comment.</p>` : html`<p class="muted"><a href="/login">Sign in</a> to comment.</p>`}
</div>`;
}

export function parseClock(s: string): number | null {
  const m = /^\s*(\d{1,3}):([0-5]\d)\s*$/.exec(s) ?? /^\s*(\d{1,5})\s*$/.exec(s);
  if (!m) return null;
  return m[2] !== undefined ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : Number(m[1]) * 1000;
}
