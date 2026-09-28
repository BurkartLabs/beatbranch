import type { FastifyReply, FastifyRequest } from "fastify";
import { render, type Deps } from "../app.js";
import { history } from "../commits/repo.js";
import { commitList } from "../commits/views.js";
import { html, type Html } from "../web/html.js";
import { hooks } from "../hooks.js";
import { divergence } from "../branches/repo.js";
import { ideaName, plural } from "../web/words.js";
import { dawName, stateName } from "./catalogue.js";
import { branchesOf, tagsOf, type Access, type Branch } from "./repo.js";
import { dayOf, projectPath, visibilityBadge } from "./views.js";
import { forkInfo, latestRelease } from "../social/repo.js";
import { getCommit, filesOf } from "../commits/repo.js";
import { listenPanel } from "../audio/module.js";


async function branchBody(deps: Deps, a: Access, branch: Branch, req: FastifyRequest): Promise<Html> {
  const list = await history(deps.db, branch.headCommitId);
  const extra: Html[] = [];
  for (const p of hooks(deps).branchPanels) extra.push(await p(deps, a, branch, req));
  let note: Html = html``;
  if (branch.name !== "main") {
    const main = (await branchesOf(deps.db, a.project.id)).find((b) => b.name === "main");
    const d = await divergence(deps.db, branch.headCommitId, main?.headCommitId ?? null);
    note = html`<p class="divergence muted">This is an idea: a copy where you can try things without touching the Main version. ${d.ahead ? `It has ${plural(d.ahead, "save")} the Main version doesn't have.` : "Nothing new in it yet."}${d.behind ? ` The Main version has ${plural(d.behind, "newer save")} since it started.` : ""}${d.ahead && a.canEdit ? html` <a href="${projectPath(a.project)}/merge?from=${encodeURIComponent(branch.name)}">Use this idea in the Main version</a>` : ""}</p>`;
  }
  return html`${extra}<section class="panel">
  <div class="row space"><h2>Saves in ${ideaName(branch.name)}</h2>${a.canEdit ? html`<a class="button primary" href="${projectPath(a.project)}/commit?branch=${encodeURIComponent(branch.name)}">Save a new version</a>` : ""}</div>
  ${note}
  ${commitList(a, list, branch.name)}
</section>`;
}

export async function projectPage(req: FastifyRequest, reply: FastifyReply, deps: Deps, a: Access): Promise<FastifyReply> {
  const { project, canEdit } = a;
  const q = req.query as { branch?: string; partial?: string };
  const [branches, tags] = await Promise.all([branchesOf(deps.db, project.id), tagsOf(deps.db, project.id)]);
  const branch = branches.find((b) => b.name === q.branch) ?? branches.find((b) => b.name === "main") ?? branches[0]!;
  const body = await branchBody(deps, a, branch, req);
  if (q.partial === "1") return reply.type("text/html; charset=utf-8").send(body.value);
  const facts: Html[] = [html`<span>${dawName(project.daw)}</span>`, html`<span>${stateName(project.state)}</span>`];
  if (project.bpm) facts.push(html`<span class="bpm">${String(project.bpm)} BPM</span>`);
  if (project.musicalKey) facts.push(html`<span>${project.musicalKey}</span>`);
  if (project.genre) facts.push(html`<span>${project.subgenre ? `${project.genre} · ${project.subgenre}` : project.genre}</span>`);
  const base = projectPath(project);
  const forks = await forkInfo(deps.db, project.id);
  const release = await latestRelease(deps.db, project.id);
  let releasePanel: Html = html``;
  if (release) {
    const rc = await getCommit(deps.db, project.id, release.commitId);
    if (rc) releasePanel = await listenPanel(deps, a, rc, (await filesOf(deps.db, rc.id)).filter((f) => f.kind === "bounce"), `Latest release: ${release.name}`);
  }
  const signedIn = !!req.user;
  const csrf = req.session?.csrfToken ?? "";
  return render(
    req,
    reply,
    deps,
    { title: project.name, styles: ["/static/projects.css", "/static/player.css", "/static/view.css"], scripts: ["/static/branch.js", "/static/player.mjs", "/static/view.js"] },
    html`<section class="project-header">
  ${project.hasCover ? html`<img class="cover" src="${base}/cover.png" alt="Picture for ${project.name}" width="96" height="96">` : ""}
  <div class="grow">
    <p class="muted crumbs"><a href="/@${project.ownerHandle}">${project.ownerName}</a> / ${project.name}</p>
    <h1>${project.name} ${visibilityBadge(project)}</h1>
    <p class="artist">by <a href="/@${project.ownerHandle}">${project.ownerName}</a>${forks.source ? html` · a copy of ${forks.source.visible ? html`<a href="/p/@${forks.source.handle}/${forks.source.slug}">${forks.source.name}</a> by @${forks.source.handle}` : "a song that is no longer public"}` : ""}</p>
    <p class="meta">${facts}<span>started ${dayOf(project.createdAt)}</span></p>
    ${project.hiddenAt !== null ? html`<p class="flash error">This project is hidden from everyone but its members${project.hiddenReason ? html`: ${project.hiddenReason}` : ""}.</p>` : ""}
  </div>
  <div class="project-actions">
    <form method="get" action="${base}" class="branch-form" data-partial="${base}">
      <label class="visually-hidden" for="branch">Which version</label>
      <select id="branch" name="branch" class="branch-select">${branches.map((b) => html`<option value="${b.name}"${b.id === branch.id ? html` selected` : ""}>${ideaName(b.name)}</option>`)}</select>
      <noscript><button class="button" type="submit">Show</button></noscript>
    </form>
    <a class="button" href="${base}/branches">Ideas</a>
    <a class="button" href="${base}/compare">What changed</a>
    ${a.role !== null ? html`<a class="button" href="${base}/people">People</a>` : ""}
    ${canEdit ? html`<a class="button" href="${base}/settings">Settings</a>` : ""}
    ${signedIn && project.visibility === "public" && req.user!.id !== project.ownerId ? html`<form method="post" action="${base}/fork"><input type="hidden" name="_csrf" value="${csrf}"><button class="button" type="submit" title="Make your own copy of this song to change however you like">Make my own copy</button></form>` : ""}
  </div>
</section>
${releasePanel}
<div id="branch-body" aria-live="polite">${body}</div>
${project.description || tags.length ? html`<section class="panel"><h2>About</h2>${project.description ? html`<p class="description">${project.description}</p>` : ""}${tags.length ? html`<p class="tags">${tags.map((t) => html`<span class="tag">${t}</span>`)}</p>` : ""}</section>` : ""}
${forks.forks.length ? html`<section class="panel"><h2>Copies other people made</h2><ul class="tags">${forks.forks.map((f) => html`<li class="tag"><a href="/p/@${f.handle}/${f.slug}">${f.name} by @${f.handle}</a></li>`)}</ul></section>` : ""}
${signedIn && project.visibility !== "private" && req.user!.id !== project.ownerId ? html`<details class="report"><summary>Report this song</summary><form method="post" action="${base}/report"><input type="hidden" name="_csrf" value="${csrf}"><label for="report-reason">What's wrong?</label><textarea id="report-reason" name="reason" required maxlength="1000"></textarea><div class="actions"><button class="button danger" type="submit">Send report</button></div></form></details>` : ""}`
  );
}
