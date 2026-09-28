import type { Deps } from "../app.js";
import type { Access } from "../projects/repo.js";
import { dayOf, projectPath } from "../projects/views.js";
import { html, type Html } from "../web/html.js";
import { ideaName, KIND_WORDS } from "../web/words.js";
import type { Commit, CommitFile } from "./repo.js";

export const short = (id: string) => id.slice(0, 7);

const KIND_LABEL: Record<CommitFile["kind"], string> = { project: KIND_WORDS.project.one, bounce: KIND_WORDS.bounce.one, stem: KIND_WORDS.stem.one, samples: KIND_WORDS.samples.one };

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
  <p class="muted commit-meta">${c.authorHandle ? html`<a href="/@${c.authorHandle}">${c.authorName}</a>` : "someone"} · ${dayOf(c.createdAt)}${c.parent2Id ? html` · <span class="badge">brought an idea in</span>` : ""}</p></div>
</li>`;
}

export function commitList(a: Access, list: Commit[], branch: string): Html {
  if (!list.length) return html`<p class="empty">Nothing saved here yet.${a.canEdit ? html` <a href="${projectPath(a.project)}/commit?branch=${encodeURIComponent(branch)}">Upload your project file</a> to make the first save.` : ""}</p>`;
  return html`<ol class="commits">${list.map((c) => commitRow(a, c))}</ol>`;
}

export async function commitView(deps: Deps, a: Access, c: Commit, files: CommitFile[], csrf?: string): Promise<Html> {
  const base = `${projectPath(a.project)}/c/${c.id}`;
  const audio = files.filter((f) => f.contentType.startsWith("audio/") && (f.kind === "stem" || f.kind === "bounce"));
  const { commitExtras } = await import("./extras.js");
  return html`<p class="muted crumbs"><a href="/@${a.project.ownerHandle}">${a.project.ownerName}</a> / <a href="${projectPath(a.project)}">${a.project.name}</a> / ${ideaName(c.branchName)}</p>
<section class="panel">
  <h1 class="commit-heading">${c.message.split("\n")[0]}</h1>
  ${c.message.includes("\n") ? html`<p class="description">${c.message.split("\n").slice(1).join("\n").trim()}</p>` : ""}
  <p class="muted">${c.authorHandle ? html`<a href="/@${c.authorHandle}">${c.authorName}</a>` : "someone"} saved this on ${dayOf(c.createdAt)}${c.parentId ? html` · <a href="${projectPath(a.project)}/c/${c.parentId}">the save before</a> · <a href="${projectPath(a.project)}/compare?a=${c.parentId}&b=${c.id}">what changed</a>` : ""}${c.parent2Id ? html` · <a href="${projectPath(a.project)}/c/${c.parent2Id}">the idea brought in</a>` : ""}</p>
  ${a.canEdit && csrf ? html`<form method="post" action="${projectPath(a.project)}/branches" class="row start-idea"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="commit" value="${c.id}"><label class="visually-hidden" for="idea-here">New idea name</label><input id="idea-here" name="name" type="text" maxlength="40" required placeholder="new idea name" class="grow"><button class="button" type="submit">Start an idea from this save</button></form>` : ""}
</section>
${await commitExtras(deps, a, c, files, audio)}
<section class="panel">
  <h2>Files</h2>
  <ul class="files">${files.map((f) => html`<li><span class="file-kind">${KIND_LABEL[f.kind]}</span><span class="file-name">${f.name}</span><span class="muted">${size(f.size)}</span><a class="button" href="${base}/f/${String(f.position)}">Download</a></li>`)}</ul>
</section>`;
}
