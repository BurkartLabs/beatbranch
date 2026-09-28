import type { FastifyReply, FastifyRequest } from "fastify";
import { render, type Deps } from "../app.js";
import { history } from "../commits/repo.js";
import { commitList } from "../commits/views.js";
import { html, type Html } from "../web/html.js";
import { divergence } from "../branches/repo.js";
import { ideaName, plural } from "../web/words.js";
import { dawName, stateName } from "./catalogue.js";
import { branchesOf, tagsOf, type Access, type Branch } from "./repo.js";
import { dayOf, projectPath, visibilityBadge } from "./views.js";

export type BranchPanel = (deps: Deps, a: Access, branch: Branch, req: FastifyRequest) => Promise<Html>;
const panels: BranchPanel[] = [];
export function addBranchPanel(p: BranchPanel): void {
  panels.push(p);
}

async function branchBody(deps: Deps, a: Access, branch: Branch, req: FastifyRequest): Promise<Html> {
  const list = await history(deps.db, branch.headCommitId);
  const extra: Html[] = [];
  for (const p of panels) extra.push(await p(deps, a, branch, req));
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
  return render(
    req,
    reply,
    deps,
    { title: project.name, styles: ["/static/projects.css", "/static/player.css", "/static/view.css"], scripts: ["/static/branch.js", "/static/player.js", "/static/view.js"] },
    html`<section class="project-header">
  <div>
    <p class="muted crumbs"><a href="/@${project.ownerHandle}">${project.ownerName}</a> / ${project.name}</p>
    <h1>${project.name} ${visibilityBadge(project)}</h1>
    <p class="artist">by <a href="/@${project.ownerHandle}">${project.ownerName}</a></p>
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
    ${canEdit ? html`<a class="button" href="${base}/settings">Settings</a>` : ""}
  </div>
</section>
<div id="branch-body" aria-live="polite">${body}</div>
${project.description || tags.length ? html`<section class="panel"><h2>About</h2>${project.description ? html`<p class="description">${project.description}</p>` : ""}${tags.length ? html`<p class="tags">${tags.map((t) => html`<span class="tag">${t}</span>`)}</p>` : ""}</section>` : ""}`
  );
}
