// Projects (AB#2747, AB#2913, and the seams AB#2780 tests): create one, its page, the explore list, a producer's page.
// Everything that shows a project goes through repo.access(), so a private or hidden project does not exist for a
// non-member (a 404 that is the same 404 as a wrong address).
import { z } from "zod";
import { refuse, render, type Deps, type Module } from "../app.js";
import { getProfileByHandle } from "../auth/users.js";
import { RATE_LIMITS, retryAfterSeconds, retryWords, takeLimit } from "../limits/limits.js";
import { errorId, html, type Html } from "../web/html.js";
import { DAWS, GENRE_NAMES, GENRES, STATES, VISIBILITIES } from "./catalogue.js";
import { access, createProject, listPublic, listPublicOf, NewProject, type NewProjectInput } from "./repo.js";
import { projectPage } from "./page.js";
import { dayOf, projectGrid } from "./views.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });

type Errors = Partial<Record<string, string>>;

function newProjectForm(values: Partial<Record<keyof NewProjectInput, string>>, errors: Errors, csrf: string): Html {
  const v = (k: keyof NewProjectInput) => values[k] ?? "";
  const err = (k: string) => (errors[k] ? html`<p class="field-error" id="${errorId(k)}">${errors[k]}</p>` : "");
  const aria = (k: string) => (errors[k] ? html` aria-invalid="true" aria-describedby="${errorId(k)}"` : "");
  const selected = (k: keyof NewProjectInput, id: string) => (v(k) === id ? html` selected` : "");
  return html`<section class="panel narrow">
  <h1>New project</h1>
  <form method="post" action="/new" novalidate>
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="name">Name</label>
    <input id="name" name="name" type="text" required maxlength="120" value="${v("name")}"${aria("name")}>${err("name")}
    <label for="daw">DAW</label>
    <select id="daw" name="daw" required${aria("daw")}>${DAWS.map((d) => html`<option value="${d.id}"${selected("daw", d.id)}>${d.name}</option>`)}</select>${err("daw")}
    <fieldset class="choices">
      <legend>Who can see it</legend>
      ${VISIBILITIES.map((o) => html`<label class="choice"><input type="radio" name="visibility" value="${o.id}"${v("visibility") === o.id || (!v("visibility") && o.id === "public") ? html` checked` : ""}><span><strong>${o.name}</strong> <span class="muted">${o.says}</span></span></label>`)}
    </fieldset>${err("visibility")}
    <div class="two">
      <div><label for="genre">Genre</label>
      <select id="genre" name="genre"${aria("genre")}><option value="">Not set</option>${GENRE_NAMES.map((g) => html`<option value="${g}"${selected("genre", g)}>${g}</option>`)}</select>${err("genre")}</div>
      <div><label for="subgenre">Subgenre</label>
      <select id="subgenre" name="subgenre" data-genres="${JSON.stringify(GENRES)}"><option value="">Not set</option>${Object.entries(GENRES).flatMap(([g, subs]) => subs.map((s) => html`<option value="${s}" data-genre="${g}"${selected("subgenre", s)}>${s}</option>`))}</select></div>
    </div>
    <div class="two">
      <div><label for="state">State</label>
      <select id="state" name="state">${STATES.map((s) => html`<option value="${s.id}"${selected("state", s.id) || (!v("state") && s.id === "idea" ? html` selected` : "")}>${s.name}</option>`)}</select></div>
      <div><label for="bpm">BPM</label>
      <input id="bpm" name="bpm" type="number" min="20" max="999" inputmode="numeric" value="${v("bpm")}"${aria("bpm")}>${err("bpm")}</div>
    </div>
    <label for="musicalKey">Key</label>
    <input id="musicalKey" name="musicalKey" type="text" maxlength="12" placeholder="F minor" value="${v("musicalKey")}">
    <label for="description">Description</label>
    <textarea id="description" name="description" maxlength="2000">${v("description")}</textarea>
    <label for="tags">Tags</label>
    <input id="tags" name="tags" type="text" maxlength="400" placeholder="808, dark, collab" value="${v("tags")}">
    <p class="hint">Comma-separated, up to twelve.</p>
    <div class="actions"><button type="submit" class="button primary">Create project</button><a class="button quiet" href="/">Cancel</a></div>
  </form>
</section>`;
}

function fieldErrors(error: z.ZodError): Errors {
  const out: Errors = {};
  const words: Record<string, string> = { name: "Give the project a name.", daw: "Pick the DAW.", visibility: "Choose who can see it.", genre: "Pick a genre from the list.", bpm: "A whole number from 20 to 999.", state: "Pick a state." };
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? "name");
    out[name] ??= words[name] ?? "Check this field.";
  }
  return out;
}

const projects: Module = {
  name: "projects",
  nav: [{ href: "/explore", label: "Explore", order: 10, who: "everyone" }],
  register(app, deps: Deps) {
    app.get("/new", async (req, reply) =>
      render(req, reply, deps, { title: "New project", current: "/new", styles: ["/static/projects.css"], scripts: ["/static/subgenre.js"] }, newProjectForm({}, {}, req.session!.csrfToken))
    );

    app.post("/new", async (req, reply) => {
      const body = req.body as Record<string, string>;
      const values: Partial<Record<keyof NewProjectInput, string>> = {};
      for (const k of ["name", "visibility", "daw", "genre", "subgenre", "description", "state", "tags", "bpm", "musicalKey"] as const) values[k] = typeof body[k] === "string" ? body[k] : "";
      // A field left empty is a field not given: the schema's defaults apply (state "idea"), and the name, visibility
      // and DAW, which have none, are refused by name.
      const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
      const parsed = NewProject.safeParse(given);
      if (!parsed.success) {
        return render(req, reply, deps, { title: "New project", current: "/new", styles: ["/static/projects.css"], scripts: ["/static/subgenre.js"] }, newProjectForm(values, fieldErrors(parsed.error), req.session!.csrfToken), 400);
      }
      const limit = await takeLimit(deps.db, "new-project", req.user!.id);
      if (!limit.ok) {
        reply.header("Retry-After", retryAfterSeconds(limit.retryAt));
        return refuse(req, reply, deps, 429, `${RATE_LIMITS["new-project"].says} Try again ${retryWords(limit.retryAt)}.`);
      }
      const project = await createProject(deps.db, req.user!.id, parsed.data);
      return reply.redirect(`/p/@${project.ownerHandle}/${project.slug}`, 303);
    });

    app.get("/p/@:handle/:slug", { config: { public: true } }, async (req, reply) => {
      const { handle, slug } = Params.parse(req.params);
      const found = await access(deps.db, handle, slug, req.user);
      if (!found) return reply.callNotFound();
      return projectPage(req, reply, deps, found);
    });

    app.get("/explore", { config: { public: true } }, async (req, reply) => {
      const list = await listPublic(deps.db);
      return render(req, reply, deps, { title: "Explore", current: "/explore", styles: ["/static/projects.css"] }, html`<h1>Explore</h1><p class="muted">Public projects, most recently changed first.</p>${projectGrid(list, html`Nothing public yet.`)}`);
    });

    app.get("/@:handle", { config: { public: true } }, async (req, reply) => {
      const { handle } = z.object({ handle: z.string().max(30) }).parse(req.params);
      const profile = await getProfileByHandle(deps.db, handle);
      if (!profile) return reply.callNotFound();
      const list = await listPublicOf(deps.db, profile.id);
      const mine = req.user?.id === profile.id;
      return render(
        req,
        reply,
        deps,
        { title: profile.displayName, styles: ["/static/projects.css"] },
        html`<section class="producer-header"><h1>${profile.displayName}</h1><p class="muted">@${profile.handle} · here since ${dayOf(profile.createdAt)}</p>${profile.bio ? html`<p>${profile.bio}</p>` : ""}</section>
<h2>Public projects</h2>${projectGrid(list, mine ? html`None public yet. Your private and unlisted projects are on <a href="/">your projects</a>.` : html`Nothing public yet.`, { showArtist: false })}`
      );
    });
  }
};

export default projects;
