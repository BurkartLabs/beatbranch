import { z } from "zod";
import { refuse, render, type Deps, type Module } from "../app.js";
import { access, branchesOf } from "../projects/repo.js";
import { projectPath } from "../projects/views.js";
import { html } from "../web/html.js";
import { ideaName, plural } from "../web/words.js";
import { createBranch, deleteBranch, divergence, findBranch, graphOf } from "./repo.js";
import { graphSvg } from "./graph.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });
const NamedParams = Params.extend({ name: z.string().max(60) });

const branches: Module = {
  name: "branches",
  register(app, deps: Deps) {
    app.get("/p/@:handle/:slug/branches", { config: { public: true } }, async (req, reply) => {
      const a = await access(deps.db, ...Object.values(Params.parse(req.params)) as [string, string], req.user);
      if (!a) return reply.callNotFound();
      const all = await branchesOf(deps.db, a.project.id);
      const main = all.find((b) => b.name === "main");
      const base = projectPath(a.project);
      const rows = [];
      for (const b of all) {
        const d = b.name === "main" ? null : await divergence(deps.db, b.headCommitId, main?.headCommitId ?? null);
        rows.push(html`<li class="idea-row">
  <div><a class="idea-name" href="${base}?branch=${encodeURIComponent(b.name)}">${ideaName(b.name)}</a>
  <p class="muted">${d ? html`${d.ahead ? `${plural(d.ahead, "save")} the Main version doesn't have` : "Nothing new yet"}${d.behind ? ` · the Main version has ${plural(d.behind, "newer save")}` : ""}` : "Where the song lives. Ideas start from here."}</p></div>
  ${a.canEdit && b.name !== "main" ? html`<form method="post" action="${base}/branches/${encodeURIComponent(b.name)}/delete">
    <input type="hidden" name="_csrf" value="${req.session!.csrfToken}">
    ${d && d.ahead ? html`<input type="hidden" name="abandon" value="1">` : ""}
    <button class="button quiet danger" type="submit">${d && d.ahead ? "Throw this idea away" : "Remove"}</button>
  </form>` : ""}
</li>`);
      }
      return render(
        req,
        reply,
        deps,
        { title: `Ideas · ${a.project.name}`, styles: ["/static/projects.css", "/static/branches.css"] },
        html`<p class="muted crumbs"><a href="${base}">${a.project.name}</a></p>
<h1>Ideas</h1>
<p class="muted">An idea is a copy of your song where you can try something without changing the Main version. If you like it, bring it into the Main version. If not, throw it away.</p>
<section class="panel"><ul class="ideas">${rows}</ul></section>
${a.canEdit ? html`<section class="panel"><h2>Try a new idea</h2>
<form method="post" action="${base}/branches" class="row">
  <input type="hidden" name="_csrf" value="${req.session!.csrfToken}">
  <label class="visually-hidden" for="idea-name">Name</label>
  <input id="idea-name" name="name" type="text" maxlength="40" required placeholder="bass-rework" class="grow">
  <label class="visually-hidden" for="idea-from">Start from</label>
  <select id="idea-from" name="from">${all.map((b) => html`<option value="${b.name}">Start from ${ideaName(b.name)}</option>`)}</select>
  <button class="button primary" type="submit">Start idea</button>
</form></section>` : ""}
<p><a href="${base}/graph">See how the ideas grew</a></p>`
      );
    });

    app.post("/p/@:handle/:slug/branches", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can start ideas.", { href: base, label: "Back" });
      const body = z.object({ name: z.string().max(80), from: z.string().max(80).optional(), commit: z.string().max(40).optional() }).parse(req.body);
      let fromCommit: string | null = null;
      if (body.commit) fromCommit = body.commit;
      else {
        const src = await findBranch(deps.db, a.project.id, body.from ?? "main");
        if (!src) return refuse(req, reply, deps, 400, "That idea doesn't exist.", { href: `${base}/branches`, label: "Back" });
        fromCommit = src.headCommitId;
      }
      const made = await createBranch(deps.db, a.project.id, body.name, fromCommit);
      if (!made.ok) return refuse(req, reply, deps, 400, made.reason, { href: `${base}/branches`, label: "Back" });
      return reply.redirect(`${base}?branch=${encodeURIComponent(made.branch.name)}`, 303);
    });

    app.post("/p/@:handle/:slug/branches/:name/delete", async (req, reply) => {
      const p = NamedParams.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can remove ideas.", { href: base, label: "Back" });
      const abandon = (req.body as { abandon?: string } | undefined)?.abandon === "1";
      const done = await deleteBranch(deps.db, a.project.id, p.name, abandon);
      if (!done.ok) return refuse(req, reply, deps, 400, done.reason, { href: `${base}/branches`, label: "Back to ideas" });
      return reply.redirect(`${base}/branches`, 303);
    });

    app.get("/p/@:handle/:slug/graph", { config: { public: true } }, async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      const nodes = await graphOf(deps.db, a.project.id);
      return render(
        req,
        reply,
        deps,
        { title: `How it grew · ${a.project.name}`, styles: ["/static/projects.css", "/static/branches.css"] },
        html`<p class="muted crumbs"><a href="${base}">${a.project.name}</a></p><h1>How the song grew</h1>
<p class="muted">Newest at the top. Each color is one idea. Lines join each save to the one before it; two lines meeting means an idea was brought into another.</p>
<section class="panel">${nodes.length ? graphSvg(nodes, (id) => `${base}/c/${id}`) : html`<p class="empty">No saves yet.</p>`}</section>`
      );
    });
  }
};

export default branches;
