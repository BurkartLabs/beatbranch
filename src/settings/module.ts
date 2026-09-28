import { z } from "zod";
import { refuse, render, SESSION_COOKIE, type Deps, type Module } from "../app.js";
import { authenticate, Bio, DisplayName, getProfileByHandle, Handle, HANDLE_COOLDOWN_MS, updateProfile } from "../auth/users.js";
import { collectGarbage, recountAccount } from "../blobs/gc.js";
import { storeOf } from "../commits/module.js";
import { GENRE_NAMES, GENRES, STATES, VISIBILITIES, knownGenre, STATE_IDS, VISIBILITY_IDS } from "../projects/catalogue.js";
import { access, parseTags, tagsOf } from "../projects/repo.js";
import { dayOf, projectPath } from "../projects/views.js";
import { html } from "../web/html.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });
const Text = (max: number) => z.string().trim().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));

const ProjectEdit = z
  .object({
    name: Text(120).pipe(z.string().min(1)),
    description: Text(2000).default(""),
    state: z.enum(STATE_IDS),
    tags: z.string().max(400).default(""),
    genre: Text(40).default(""),
    subgenre: Text(40).default(""),
    bpm: z.union([z.literal(""), z.coerce.number().int().min(20).max(999)]).default(""),
    musicalKey: Text(12).default(""),
    visibility: z.enum(VISIBILITY_IDS).optional()
  })
  .refine((p) => knownGenre(p.genre, p.subgenre), { path: ["genre"] });

const settings: Module = {
  name: "settings",
  register(app, deps: Deps) {
    app.get("/p/@:handle/:slug/settings", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change its details.", { href: projectPath(a.project), label: "Back" });
      const pr = a.project;
      const tags = (await tagsOf(deps.db, pr.id)).join(", ");
      const csrf = req.session!.csrfToken;
      const owner = a.role === "owner";
      const remix = !!(await deps.db.get<{ open_for_remix: boolean }>("SELECT open_for_remix FROM projects WHERE id = ?", [pr.id]))?.open_for_remix;
      const sel = (cur: string, id: string) => (cur === id ? html` selected` : "");
      return render(
        req,
        reply,
        deps,
        { title: `Settings · ${pr.name}`, styles: ["/static/projects.css"], scripts: ["/static/subgenre.js"] },
        html`<section class="panel narrow">
  <p class="muted crumbs"><a href="${projectPath(pr)}">${pr.name}</a></p>
  <h1>Song details</h1>
  <form method="post" action="${projectPath(pr)}/settings">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="name">Name</label><input id="name" name="name" type="text" required maxlength="120" value="${pr.name}">
    <label for="state">How far along is it?</label>
    <select id="state" name="state">${STATES.map((s) => html`<option value="${s.id}"${sel(pr.state, s.id)}>${s.name}</option>`)}</select>
    ${owner ? html`<fieldset class="choices"><legend>Who can see it</legend>${VISIBILITIES.map((o) => html`<label class="choice"><input type="radio" name="visibility" value="${o.id}"${pr.visibility === o.id ? html` checked` : ""}><span><strong>${o.name}</strong> <span class="muted">${o.says}</span></span></label>`)}</fieldset>` : ""}
    <div class="two">
      <div><label for="genre">Genre</label><select id="genre" name="genre"><option value="">Not set</option>${GENRE_NAMES.map((g) => html`<option value="${g}"${sel(pr.genre, g)}>${g}</option>`)}</select></div>
      <div><label for="subgenre">Subgenre</label><select id="subgenre" name="subgenre"><option value="">Not set</option>${Object.entries(GENRES).flatMap(([g, subs]) => subs.map((s) => html`<option value="${s}" data-genre="${g}"${pr.genre === g && pr.subgenre === s ? html` selected` : ""}>${s}</option>`))}</select></div>
    </div>
    <div class="two">
      <div><label for="bpm">BPM</label><input id="bpm" name="bpm" type="number" min="20" max="999" value="${pr.bpm === null ? "" : String(pr.bpm)}"></div>
      <div><label for="musicalKey">Key</label><input id="musicalKey" name="musicalKey" type="text" maxlength="12" value="${pr.musicalKey}"></div>
    </div>
    <label for="description">Description</label><textarea id="description" name="description" maxlength="2000">${pr.description}</textarea>
    <label for="tags">Tags</label><input id="tags" name="tags" type="text" maxlength="400" value="${tags}">
    <p class="hint">Comma-separated, up to twelve.</p>
    <div class="actions"><button class="button primary" type="submit">Save details</button></div>
  </form>
</section>
<section class="panel narrow"><h2>Picture</h2>
  <form method="post" action="${projectPath(pr)}/cover" enctype="multipart/form-data" class="row">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label class="visually-hidden" for="cover">Picture</label>
    <input id="cover" name="cover" type="file" accept="image/png,image/jpeg,image/webp" required class="grow">
    <button class="button" type="submit">Upload picture</button>
  </form>
  <p class="hint">A square PNG, JPEG or WebP, up to 10 MB. BeatBranch makes its own copy at 512 by 512.</p>
</section>
${owner ? html`<section class="panel narrow"><h2>Remixes</h2>
  <form method="post" action="${projectPath(pr)}/remix" class="row">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="open" value="${remix ? "0" : "1"}">
    <p class="grow">${remix ? "This song is open for remixes: it's listed on Explore under “Open for remix”." : "Let other producers know they're welcome to make their own copy and remix it."}</p>
    <button class="button" type="submit">${remix ? "Close for remixes" : "Open for remixes"}</button>
  </form>
</section>` : ""}
${owner ? html`<section class="panel narrow danger-zone">
  <h2>Delete this song</h2>
  <p class="muted">Deletes every save, idea and file in it. This can't be undone.</p>
  <form method="post" action="${projectPath(pr)}/delete">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="confirm">Type the song's name to confirm</label>
    <input id="confirm" name="confirm" type="text" required autocomplete="off">
    <div class="actions"><button class="button danger" type="submit">Delete forever</button></div>
  </form>
</section>` : ""}`
      );
    });

    app.post("/p/@:handle/:slug/settings", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const back = { href: `${projectPath(a.project)}/settings`, label: "Back to the details" };
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change its details.", back);
      const body = Object.fromEntries(Object.entries(req.body as Record<string, string>).filter(([k, v]) => k !== "_csrf" && v !== ""));
      const parsed = ProjectEdit.safeParse({ state: a.project.state, ...body });
      if (!parsed.success) return refuse(req, reply, deps, 400, "Something in the form isn't right: check the name, the genre and the BPM.", back);
      const e = parsed.data;
      const visibility = a.role === "owner" && e.visibility ? e.visibility : a.project.visibility;
      await deps.db.transaction(async () => {
        await deps.db.run("UPDATE projects SET name = ?, description = ?, state = ?, genre = ?, subgenre = ?, bpm = ?, musical_key = ?, visibility = ?, updated_at = ? WHERE id = ?", [
          e.name, e.description, e.state, e.genre, e.subgenre, e.bpm === "" ? null : e.bpm, e.musicalKey, visibility, Date.now(), a.project.id
        ]);
        await deps.db.run("DELETE FROM project_tags WHERE project_id = ?", [a.project.id]);
        for (const t of parseTags(e.tags)) await deps.db.run("INSERT INTO project_tags (project_id, tag) VALUES (?, ?)", [a.project.id, t]);
      });
      return reply.redirect(projectPath(a.project), 303);
    });

    app.post("/p/@:handle/:slug/delete", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      if (a.role !== "owner") return refuse(req, reply, deps, 403, "Only the song's owner can delete it.", { href: projectPath(a.project), label: "Back" });
      const confirm = String((req.body as { confirm?: string }).confirm ?? "").trim();
      if (confirm !== a.project.name) return refuse(req, reply, deps, 400, "The name you typed doesn't match, so nothing was deleted.", { href: `${projectPath(a.project)}/settings`, label: "Back" });
      const members = (await deps.db.all<{ user_id: string }>("SELECT DISTINCT author_id AS user_id FROM commits WHERE project_id = ? AND author_id IS NOT NULL", [a.project.id])).map((r) => r.user_id);
      await deps.db.run("DELETE FROM projects WHERE id = ?", [a.project.id]);
      for (const u of new Set([...members, req.user!.id])) await recountAccount(deps.db, u);
      await collectGarbage(deps.db, storeOf(deps));
      return reply.redirect("/", 303);
    });

    app.get("/settings", async (req, reply) => {
      const me = await getProfileByHandle(deps.db, req.user!.handle);
      const changedAt = (await deps.db.get<{ t: number | null }>("SELECT handle_changed_at AS t FROM users WHERE id = ?", [req.user!.id]))?.t;
      const next = changedAt ? Number(changedAt) + HANDLE_COOLDOWN_MS : null;
      const locked = next !== null && next > Date.now();
      const csrf = req.session!.csrfToken;
      return render(
        req,
        reply,
        deps,
        { title: "Settings", current: "/settings", styles: ["/static/projects.css"] },
        html`<section class="panel narrow">
  <h1>Your profile</h1>
  <form method="post" action="/settings">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="displayName">Artist name</label><input id="displayName" name="displayName" type="text" required maxlength="80" value="${me!.displayName}">
    <label for="handle">Handle</label><input id="handle" name="handle" type="text" required maxlength="30" value="${me!.handle}"${locked ? html` readonly` : ""}>
    <p class="hint">${locked ? `You can change it again on ${dayOf(next!)}.` : "Your page's address. You can change it once a month."}</p>
    <label for="bio">About you</label><textarea id="bio" name="bio" maxlength="500">${me!.bio}</textarea>
    <div class="actions"><button class="button primary" type="submit">Save profile</button><a class="button quiet" href="/@${me!.handle}">See your page</a></div>
  </form>
</section>
<section class="panel narrow danger-zone">
  <h2>Delete your account</h2>
  <p class="muted">Deletes your account, your songs and every file only you uploaded. This can't be undone.</p>
  <form method="post" action="/settings/delete">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="password">Your password</label><input id="password" name="password" type="password" required autocomplete="current-password">
    <div class="actions"><button class="button danger" type="submit">Delete my account</button></div>
  </form>
</section>`
      );
    });

    app.post("/settings", async (req, reply) => {
      const b = req.body as Record<string, string>;
      const back = { href: "/settings", label: "Back to settings" };
      const name = DisplayName.safeParse(b.displayName ?? "");
      const bio = Bio.safeParse(b.bio ?? "");
      const handle = Handle.safeParse(b.handle ?? "");
      if (!name.success || !bio.success || !handle.success) return refuse(req, reply, deps, 400, "Check your artist name, handle (3 to 30 letters, numbers or dashes) and about text.", back);
      const r = await updateProfile(deps.db, req.user!.id, { displayName: name.data, bio: bio.data, handle: handle.data });
      if (!r.ok) {
        const text = r.reason === "handle-taken" ? "That handle is taken." : r.reason === "handle-reserved" ? "That handle isn't available." : `You changed your handle recently. You can change it again on ${dayOf(r.retryAt!)}.`;
        return refuse(req, reply, deps, 409, text, back);
      }
      return reply.redirect(`/@${handle.data}`, 303);
    });

    app.post("/settings/delete", async (req, reply) => {
      const b = req.body as Record<string, string>;
      const ok = await authenticate(deps.db, req.user!.email, String(b.password ?? "").slice(0, 256));
      if (!ok || ok.id !== req.user!.id) return refuse(req, reply, deps, 403, "That password isn't right, so nothing was deleted.", { href: "/settings", label: "Back" });
      const others = (await deps.db.all<{ id: string }>("SELECT DISTINCT c.author_id AS id FROM commits c JOIN projects p ON p.id = c.project_id WHERE p.owner_id = ? AND c.author_id IS NOT NULL AND c.author_id <> ?", [req.user!.id, req.user!.id])).map((r) => r.id);
      await deps.db.run("DELETE FROM users WHERE id = ?", [req.user!.id]);
      for (const u of others) await recountAccount(deps.db, u);
      await collectGarbage(deps.db, storeOf(deps));
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.redirect("/", 303);
    });
  }
};

export default settings;
