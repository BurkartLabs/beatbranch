import crypto from "node:crypto";
import { z } from "zod";
import { refuse, render, type Deps, type Module } from "../app.js";
import { getCommit, filesOf } from "../commits/repo.js";
import { RATE_LIMITS, retryAfterSeconds, retryWords, takeLimit } from "../limits/limits.js";
import { GENRE_NAMES } from "../projects/catalogue.js";
import { access, listPublic } from "../projects/repo.js";
import { dayOf, projectGrid, projectPath } from "../projects/views.js";
import { html } from "../web/html.js";
import { addComment, parseClock } from "./comments.js";
import { acceptInvite, activityFor, createInvite, findInvite, fork, members } from "./repo.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });
const CommitParams = Params.extend({ id: z.string().max(40) });
const Text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));

const social: Module = {
  name: "social",
  nav: [{ href: "/activity", label: "Activity", order: 20, who: "signed-in" }],
  register(app, deps: Deps) {
    app.post("/p/@:handle/:slug/c/:id/comments", async (req, reply) => {
      const p = CommitParams.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const c = await getCommit(deps.db, a.project.id, p.id);
      if (!c) return reply.callNotFound();
      const back = { href: `${projectPath(a.project)}/c/${c.id}`, label: "Back to the save" };
      if (a.role === null) return refuse(req, reply, deps, 403, "Only people on this song can comment.", back);
      const b = req.body as Record<string, string>;
      const body = Text(2000).safeParse(b.body ?? "");
      if (!body.success) return refuse(req, reply, deps, 400, "Write a comment first.", back);
      let at: number | null = null;
      if (b.timed === "1") {
        at = parseClock(String(b.at ?? ""));
        if (at === null) return refuse(req, reply, deps, 400, "Write the time like 1:23.", back);
      }
      await addComment(deps.db, a.project.id, c.id, req.user!.id, body.data, at);
      return reply.redirect(`${projectPath(a.project)}/c/${c.id}`, 303);
    });

    app.post("/p/@:handle/:slug/invites", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (a.role !== "owner") return refuse(req, reply, deps, 403, "Only the song's owner can invite people.", { href: projectPath(a.project), label: "Back" });
      const role = z.enum(["collaborator", "listener"]).parse((req.body as { role?: string }).role);
      const token = await createInvite(deps.db, a.project.id, role, req.user!.id);
      const link = `${deps.config.publicUrl}/join/${token}`;
      return render(req, reply, deps, { title: "Invite link", styles: ["/static/projects.css"] }, html`<section class="panel narrow">
  <h1>Invite link</h1>
  <p>Send this link to the person you want to invite. It works once, for 14 days. They'll be able to ${role === "collaborator" ? "listen, comment and save new versions" : "listen and comment"}.</p>
  <p><input type="text" readonly value="${link}" class="mono" aria-label="Invite link"></p>
  <p class="muted">You won't see this link again, so copy it now.</p>
  <p><a class="button" href="${projectPath(a.project)}/people">Back to people</a></p>
</section>`);
    });

    app.get("/p/@:handle/:slug/people", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const list = await members(deps.db, a.project.id);
      const csrf = req.session!.csrfToken;
      const roleWord: Record<string, string> = { owner: "Owner", collaborator: "Can save new versions", listener: "Can listen and comment" };
      return render(req, reply, deps, { title: `People · ${a.project.name}`, styles: ["/static/projects.css", "/static/branches.css"] }, html`<p class="muted crumbs"><a href="${projectPath(a.project)}">${a.project.name}</a></p>
<h1>People on this song</h1>
<section class="panel"><ul class="ideas">${list.map((m) => html`<li class="idea-row"><div><a class="idea-name" href="/@${m.handle}">${m.name}</a><p class="muted">${roleWord[m.role] ?? m.role}</p></div>
${a.role === "owner" && m.role !== "owner" ? html`<form method="post" action="${projectPath(a.project)}/people/${m.handle}/remove"><input type="hidden" name="_csrf" value="${csrf}"><button class="button quiet danger" type="submit">Remove</button></form>` : ""}</li>`)}</ul></section>
${a.role === "owner" ? html`<section class="panel"><h2>Invite someone</h2>
<form method="post" action="${projectPath(a.project)}/invites" class="row">
  <input type="hidden" name="_csrf" value="${csrf}">
  <label class="visually-hidden" for="role">What they can do</label>
  <select id="role" name="role"><option value="collaborator">Can save new versions</option><option value="listener">Can listen and comment</option></select>
  <button class="button primary" type="submit">Make an invite link</button>
</form></section>` : ""}`);
    });

    app.post("/p/@:handle/:slug/people/:who/remove", async (req, reply) => {
      const p = Params.extend({ who: z.string().max(30) }).parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (a.role !== "owner") return refuse(req, reply, deps, 403, "Only the song's owner can remove people.", { href: projectPath(a.project), label: "Back" });
      await deps.db.run("DELETE FROM project_members WHERE project_id = ? AND role <> 'owner' AND user_id = (SELECT id FROM users WHERE handle = ?)", [a.project.id, p.who.toLowerCase()]);
      return reply.redirect(`${projectPath(a.project)}/people`, 303);
    });

    app.get("/join/:token", { config: { public: true } }, async (req, reply) => {
      const { token } = z.object({ token: z.string().max(80) }).parse(req.params);
      const inv = await findInvite(deps.db, token);
      if (!inv || inv.expired || inv.used) return refuse(req, reply, deps, 404, "This invite link has been used, has run out, or doesn't exist. Ask for a new one.", { href: "/", label: "Home" });
      if (!req.user) return reply.redirect(`/register?next=${encodeURIComponent(`/join/${token}`)}`, 303);
      return render(req, reply, deps, { title: "Join a song" }, html`<section class="panel narrow"><h1>Join “${inv.projectName}”</h1>
<p>You've been invited to ${inv.role === "collaborator" ? "work on this song: you'll be able to listen, comment and save new versions" : "listen to this song and comment on it"}.</p>
<form method="post" action="/join/${token}"><input type="hidden" name="_csrf" value="${req.session!.csrfToken}"><div class="actions"><button class="button primary" type="submit">Join</button><a class="button quiet" href="/">Not now</a></div></form></section>`);
    });

    app.post("/join/:token", async (req, reply) => {
      const { token } = z.object({ token: z.string().max(80) }).parse(req.params);
      const inv = await acceptInvite(deps.db, token, req.user!.id);
      if (!inv) return refuse(req, reply, deps, 404, "This invite link has been used, has run out, or doesn't exist. Ask for a new one.", { href: "/", label: "Home" });
      return reply.redirect(`/p/@${inv.ownerHandle}/${inv.slug}`, 303);
    });

    app.post("/p/@:handle/:slug/fork", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (a.project.visibility !== "public") return refuse(req, reply, deps, 403, "Only public songs can be copied.", { href: projectPath(a.project), label: "Back" });
      if (a.project.ownerId === req.user!.id) return refuse(req, reply, deps, 400, "This song is already yours.", { href: projectPath(a.project), label: "Back" });
      const limit = await takeLimit(deps.db, "new-project", req.user!.id);
      if (!limit.ok) {
        reply.header("Retry-After", retryAfterSeconds(limit.retryAt));
        return refuse(req, reply, deps, 429, `${RATE_LIMITS["new-project"].says} Try again ${retryWords(limit.retryAt)}.`);
      }
      const copy = await fork(deps.db, a.project, req.user!.id);
      return reply.redirect(projectPath(copy), 303);
    });

    app.post("/p/@:handle/:slug/c/:id/release", async (req, reply) => {
      const p = CommitParams.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const c = await getCommit(deps.db, a.project.id, p.id);
      if (!c) return reply.callNotFound();
      const back = { href: `${projectPath(a.project)}/c/${c.id}`, label: "Back to the save" };
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can release it.", back);
      if (!(await filesOf(deps.db, c.id)).some((f) => f.kind === "bounce")) return refuse(req, reply, deps, 400, "A release needs the full song: save a new version with the full song attached first.", back);
      const name = Text(60).safeParse((req.body as { name?: string }).name ?? "");
      if (!name.success) return refuse(req, reply, deps, 400, "Give the release a name, like “v1” or “Final”.", back);
      try {
        await deps.db.run("INSERT INTO releases (id, project_id, commit_id, name, created_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), a.project.id, c.id, name.data, Date.now()]);
      } catch {
        return refuse(req, reply, deps, 409, "There's already a release with that name.", back);
      }
      await deps.db.run("UPDATE projects SET state = 'released', updated_at = ? WHERE id = ?", [Date.now(), a.project.id]);
      return reply.redirect(projectPath(a.project), 303);
    });

    app.post("/p/@:handle/:slug/report", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const back = { href: projectPath(a.project), label: "Back to the song" };
      const reason = Text(1000).safeParse((req.body as { reason?: string }).reason ?? "");
      if (!reason.success) return refuse(req, reply, deps, 400, "Say what's wrong, in a few words.", back);
      const limit = await takeLimit(deps.db, "report", req.user!.id);
      if (!limit.ok) {
        reply.header("Retry-After", retryAfterSeconds(limit.retryAt));
        return refuse(req, reply, deps, 429, `${RATE_LIMITS.report.says} Try again ${retryWords(limit.retryAt)}.`, back);
      }
      await deps.db.run("INSERT INTO reports (id, project_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), a.project.id, req.user!.id, reason.data, Date.now()]);
      return render(req, reply, deps, { title: "Reported" }, html`<section class="panel narrow"><h1>Thanks for telling us</h1><p>Someone will look at “${a.project.name}” soon.</p><p><a class="button" href="${projectPath(a.project)}">Back to the song</a></p></section>`);
    });

    app.get("/activity", async (req, reply) => {
      const list = await activityFor(deps.db, req.user!.id);
      return render(req, reply, deps, { title: "Activity", current: "/activity", styles: ["/static/projects.css", "/static/branches.css"] }, html`<h1>What's new on your songs</h1>
${list.length ? html`<section class="panel"><ul class="ideas">${list.map((x) => html`<li class="idea-row"><div><a class="idea-name" href="/p/@${x.handle}/${x.slug}/c/${x.commit_id}">${x.kind === "save" ? x.message.split("\n")[0] : `“${x.message.slice(0, 120)}”`}</a>
<p class="muted">${x.who ?? "someone"} ${x.kind === "save" ? "saved a new version of" : "commented on"} ${x.project_name} · ${dayOf(Number(x.at))}</p></div></li>`)}</ul></section>` : html`<p class="empty">Nothing yet. When you or the people on your songs save or comment, it shows up here.</p>`}`);
    });

    app.get("/explore", { config: { public: true } }, async (req, reply) => {
      const q = z.object({ genre: z.string().max(40).optional(), remix: z.string().max(2).optional() }).parse(req.query);
      const genre = q.genre && GENRE_NAMES.includes(q.genre) ? q.genre : "";
      const remix = q.remix === "1";
      let list = await listPublic(deps.db, 500);
      if (genre) list = list.filter((p) => p.genre === genre);
      if (remix) {
        const open = new Set((await deps.db.all<{ id: string }>("SELECT id FROM projects WHERE open_for_remix")).map((r) => r.id));
        list = list.filter((p) => open.has(p.id));
      }
      return render(req, reply, deps, { title: "Explore", current: "/explore", styles: ["/static/projects.css"] }, html`<h1>Explore</h1>
<form method="get" action="/explore" class="row filters">
  <label class="visually-hidden" for="genre">Genre</label>
  <select id="genre" name="genre"><option value="">Every genre</option>${GENRE_NAMES.map((g) => html`<option value="${g}"${g === genre ? html` selected` : ""}>${g}</option>`)}</select>
  <label class="choice-inline"><input type="checkbox" name="remix" value="1"${remix ? html` checked` : ""}> Open for remix</label>
  <button class="button" type="submit">Show</button>
</form>
<p class="muted">Public songs, most recently changed first.</p>
${projectGrid(list.slice(0, 60), html`Nothing here yet.`)}`);
    });

    app.post("/p/@:handle/:slug/remix", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (a.role !== "owner") return refuse(req, reply, deps, 403, "Only the song's owner can change that.", { href: projectPath(a.project), label: "Back" });
      const on = (req.body as { open?: string }).open === "1";
      await deps.db.run("UPDATE projects SET open_for_remix = ? WHERE id = ?", [on, a.project.id]);
      return reply.redirect(`${projectPath(a.project)}/settings`, 303);
    });

    app.get("/admin/reports", async (req, reply) => {
      if (req.user!.role !== "admin") return reply.callNotFound();
      const reports = await deps.db.all<{ id: string; reason: string; created_at: number; name: string; slug: string; handle: string; hidden_at: number | null }>(
        "SELECT r.id, r.reason, r.created_at, p.name, p.slug, u.handle, p.hidden_at FROM reports r JOIN projects p ON p.id = r.project_id JOIN users u ON u.id = p.owner_id WHERE r.resolved_at IS NULL ORDER BY r.created_at"
      );
      const pending = await deps.db.all<{ id: string; handle: string; display_name: string; created_at: number }>("SELECT id, handle, display_name, created_at FROM users WHERE verified_at IS NULL ORDER BY created_at");
      const csrf = req.session!.csrfToken;
      return render(req, reply, deps, { title: "Reports", styles: ["/static/projects.css", "/static/branches.css"] }, html`<h1>Reports</h1>
<section class="panel">${reports.length ? html`<ul class="ideas">${reports.map((r) => html`<li class="idea-row"><div><a class="idea-name" href="/p/@${r.handle}/${r.slug}">${r.name}</a><p class="muted">${dayOf(Number(r.created_at))}: ${r.reason}</p></div>
<div class="row"><form method="post" action="/admin/reports/${r.id}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="hide"><input type="text" name="why" maxlength="200" placeholder="Why it's hidden" aria-label="Why it's hidden"><button class="button danger" type="submit">Hide the song</button></form>
<form method="post" action="/admin/reports/${r.id}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="dismiss"><button class="button quiet" type="submit">Nothing wrong</button></form></div></li>`)}</ul>` : html`<p class="empty">No open reports.</p>`}</section>
<h2>Waiting to be approved</h2>
<p class="muted">New accounts can make songs but can't upload until they're approved here, or they join a song by invite.</p>
<section class="panel">${pending.length ? html`<ul class="ideas">${pending.map((u) => html`<li class="idea-row"><div><a class="idea-name" href="/@${u.handle}">${u.display_name}</a><p class="muted">@${u.handle} · joined ${dayOf(Number(u.created_at))}</p></div><form method="post" action="/admin/users/${u.id}/approve"><input type="hidden" name="_csrf" value="${csrf}"><button class="button primary" type="submit">Approve</button></form></li>`)}</ul>` : html`<p class="empty">Nobody waiting.</p>`}</section>`);
    });

    app.post("/admin/reports/:id", async (req, reply) => {
      if (req.user!.role !== "admin") return reply.callNotFound();
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = req.body as { action?: string; why?: string };
      const r = await deps.db.get<{ project_id: string }>("SELECT project_id FROM reports WHERE id = ?", [id]);
      if (!r) return reply.callNotFound();
      if (b.action === "hide") await deps.db.run("UPDATE projects SET hidden_at = ?, hidden_reason = ? WHERE id = ?", [Date.now(), String(b.why ?? "").slice(0, 200), r.project_id]);
      await deps.db.run("UPDATE reports SET resolved_at = ? WHERE project_id = ? AND resolved_at IS NULL", [Date.now(), r.project_id]);
      return reply.redirect("/admin/reports", 303);
    });

    app.post("/admin/users/:id/approve", async (req, reply) => {
      if (req.user!.role !== "admin") return reply.callNotFound();
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      await deps.db.run("UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?", [Date.now(), id]);
      return reply.redirect("/admin/reports", 303);
    });
  }
};

export default social;
