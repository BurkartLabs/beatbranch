// The front door: signed out, what BeatBranch is and how to start; signed in, the producer's own projects (the list
// itself arrives with the projects module, AB#2747, which replaces the empty state below).
import { render, type Module } from "../app.js";
import { html } from "../web/html.js";

const home: Module = {
  name: "home",
  register(app, deps) {
    app.get("/", { config: { public: true } }, async (req, reply) => {
      if (!req.user) {
        return render(
          req,
          reply,
          deps,
          { title: "GitHub for music producers", current: "/", fullWidth: true },
          html`<section class="hero">
  <h1>Version control for your beats.</h1>
  <p>Upload your DAW project. Commit every session with a message, branch when you want to try something, merge when the other branch was better, and let a collaborator hear it in the browser without owning the DAW.</p>
  <div class="actions"><a class="button primary" href="/register">Create an account</a><a class="button" href="/explore">Explore public projects</a></div>
</section>`
        );
      }
      return render(req, reply, deps, { title: "Your projects", current: "/" }, html`<section class="panel"><h1>Your projects</h1><p class="empty">No projects yet. <a href="/new">Create your first project</a> and upload the DAW file.</p></section>`);
    });
  }
};

export default home;
