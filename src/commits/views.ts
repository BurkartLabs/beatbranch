import type { Deps } from "../app.js";
import type { Access } from "../projects/repo.js";
import { dayOf, projectPath } from "../projects/views.js";
import { html, type Html } from "../web/html.js";
import type { Commit, CommitFile } from "./repo.js";

export const short = (id: string) => id.slice(0, 7);

const KIND_LABEL: Record<CommitFile["kind"], string> = { project: "Project file", bounce: "Bounce", stem: "Stem", samples: "Sample bundle" };

export function size(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function commitRow(a: Access, c: Commit): Html {
  const [title, ...rest] = c.message.split("\n");
  return html`<li class="commit">
  <div class="commit-main"><a class="commit-title" href="${projectPath(a.project)}/c/${c.id}">${title}</a>${rest.join("").trim() ? html` <span class="muted">…</span>` : ""}
  <p class="muted commit-meta">${c.authorHandle ? html`<a href="/@${c.authorHandle}">${c.authorName}</a>` : "someone"} · ${dayOf(c.createdAt)}${c.parent2Id ? html` · <span class="badge">merge</span>` : ""}</p></div>
  <a class="sha mono" href="${projectPath(a.project)}/c/${c.id}">${short(c.id)}</a>
</li>`;
}

export function commitList(a: Access, list: Commit[], branch: string): Html {
  if (!list.length) return html`<p class="empty">No commits yet on <code>${branch}</code>.${a.canEdit ? html` <a href="${projectPath(a.project)}/commit?branch=${encodeURIComponent(branch)}">Commit the project file</a>.` : ""}</p>`;
  return html`<ol class="commits">${list.map((c) => commitRow(a, c))}</ol>`;
}

export async function commitView(deps: Deps, a: Access, c: Commit, files: CommitFile[]): Promise<Html> {
  const base = `${projectPath(a.project)}/c/${c.id}`;
  const audio = files.filter((f) => f.contentType.startsWith("audio/") && (f.kind === "stem" || f.kind === "bounce"));
  const { commitExtras } = await import("./extras.js");
  return html`<p class="muted crumbs"><a href="/@${a.project.ownerHandle}">${a.project.ownerName}</a> / <a href="${projectPath(a.project)}">${a.project.name}</a> / <code>${c.branchName}</code></p>
<section class="panel">
  <h1 class="commit-heading">${c.message.split("\n")[0]}</h1>
  ${c.message.includes("\n") ? html`<p class="description">${c.message.split("\n").slice(1).join("\n").trim()}</p>` : ""}
  <p class="muted">${c.authorHandle ? html`<a href="/@${c.authorHandle}">${c.authorName}</a>` : "someone"} committed on ${dayOf(c.createdAt)} · <span class="mono">${short(c.id)}</span>${c.parentId ? html` · parent <a class="mono" href="${projectPath(a.project)}/c/${c.parentId}">${short(c.parentId)}</a>` : ""}${c.parent2Id ? html` and <a class="mono" href="${projectPath(a.project)}/c/${c.parent2Id}">${short(c.parent2Id)}</a>` : ""}</p>
</section>
${await commitExtras(deps, a, c, files, audio)}
<section class="panel">
  <h2>Files</h2>
  <ul class="files">${files.map((f) => html`<li><span class="file-kind">${KIND_LABEL[f.kind]}</span><span class="file-name">${f.name}</span><span class="muted">${size(f.size)}</span><a class="button" href="${base}/f/${String(f.position)}">Download</a></li>`)}</ul>
</section>`;
}
