import { z } from "zod";
import { render, type Deps, type Module } from "../app.js";
import { peaksOf, player } from "../audio/module.js";
import { filesOf, getCommit, modelOf, type Commit } from "../commits/repo.js";
import { Model } from "../parsers/model.js";
import { renderModel } from "../parsers/view.js";
import { access, branchesOf } from "../projects/repo.js";
import { dayOf, projectPath } from "../projects/views.js";
import { html, trusted, type Html } from "../web/html.js";
import { ideaName } from "../web/words.js";
import { diffFiles, diffModels, KIND_TITLES, type ChangeKind } from "./diff.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });

export async function modelFor(deps: Deps, c: Commit): Promise<Model | null> {
  if (c.parseStatus !== "ok") return null;
  const parsed = Model.safeParse(await modelOf(deps.db, c.id));
  return parsed.success && !parsed.data.metadataOnly ? parsed.data : null;
}

function miniWave(peaks: number[], label: string): Html {
  const n = peaks.length / 2;
  if (!n) return html`<div class="mini-wave empty">${label}: no waveform</div>`;
  const w = 600;
  const h = 48;
  const step = w / n;
  let d = "";
  for (let i = 0; i < n; i++) {
    const hi = peaks[2 * i + 1]! / 127;
    const lo = peaks[2 * i]! / 127;
    d += `M${(i * step).toFixed(1)} ${(h / 2 - (hi * h) / 2).toFixed(1)}V${(h / 2 - (lo * h) / 2 + 0.5).toFixed(1)}`;
  }
  return html`<figure class="mini-wave"><figcaption>${label}</figcaption>${trusted(`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true"><path d="${d}" class="wave-path"/></svg>`)}</figure>`;
}

const diff: Module = {
  name: "diff",
  register(app, deps: Deps) {
    app.get("/p/@:handle/:slug/compare", { config: { public: true } }, async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      const q = z.object({ a: z.string().max(40).optional(), b: z.string().max(40).optional() }).parse(req.query);
      const all = await deps.db.all<{ id: string; message: string; created_at: number; branch: string }>(
        "SELECT c.id, c.message, c.created_at, b.name AS branch FROM commits c JOIN branches b ON b.id = c.branch_id WHERE c.project_id = ? ORDER BY c.created_at DESC LIMIT 300",
        [a.project.id]
      );
      const main = (await branchesOf(deps.db, a.project.id)).find((x) => x.name === "main");
      let after = q.b ? await getCommit(deps.db, a.project.id, q.b) : main?.headCommitId ? await getCommit(deps.db, a.project.id, main.headCommitId) : null;
      let before = q.a ? await getCommit(deps.db, a.project.id, q.a) : after?.parentId ? await getCommit(deps.db, a.project.id, after.parentId) : null;
      if (!after && all[0]) after = await getCommit(deps.db, a.project.id, all[0].id);
      if (!before && all[1]) before = await getCommit(deps.db, a.project.id, all[1].id);
      const picker = (name: string, label: string, chosen: Commit | null) => html`<label for="${name}">${label}</label><select id="${name}" name="${name}">${all.map((c) => html`<option value="${c.id}"${chosen?.id === c.id ? html` selected` : ""}>${c.message.split("\n")[0]!.slice(0, 60)} · ${ideaName(c.branch)} · ${dayOf(Number(c.created_at))}</option>`)}</select>`;
      const head = html`<p class="muted crumbs"><a href="${base}">${a.project.name}</a></p>
<h1>What changed</h1>
<form method="get" action="${base}/compare" class="panel compare-form"><div class="two"><div>${picker("a", "Before", before)}</div><div>${picker("b", "After", after)}</div></div><div class="actions"><button class="button primary" type="submit">Compare</button></div></form>`;
      if (!before || !after) return render(req, reply, deps, { title: `What changed · ${a.project.name}`, styles: ["/static/projects.css"] }, html`${head}<p class="empty">You need two saves to compare.</p>`);

      const [fa, fb, ma, mb] = await Promise.all([filesOf(deps.db, before.id), filesOf(deps.db, after.id), modelFor(deps, before), modelFor(deps, after)]);
      let structural: Html;
      let overlay: Html = html``;
      if (!ma || !mb) {
        structural = html`<p class="flash ok">A detailed comparison isn't available for this kind of project${!ma && !mb ? "" : " for one of these saves"}: BeatBranch can't see inside it. The audio and files below still show what changed.</p>`;
      } else {
        const d = diffModels(ma, mb);
        const groups = new Map<ChangeKind, typeof d.changes>();
        for (const c of d.changes) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
        structural = d.changes.length
          ? html`<div class="diff-groups">${[...groups.entries()].map(([k, list]) => html`<div class="diff-group"><h3>${KIND_TITLES[k]}</h3><ul>${list.map((c) => html`<li class="diff-${c.what}"><span class="diff-mark" aria-hidden="true">${c.what === "added" ? "+" : c.what === "removed" ? "−" : "~"}</span> ${c.text}</li>`)}</ul></div>`)}</div>`
          : html`<p class="muted">Nothing changed inside the project.</p>`;
        overlay = html`<section class="panel"><h2>On the timeline</h2><p class="muted">Instruments that changed are highlighted.</p>${renderModel(mb, "d-", { changed: d.changedTracks, added: d.addedTracks })}</section>`;
      }
      const files = diffFiles(fa, fb);
      const audioRows: Html[] = [];
      for (const f of files) {
        if (f.what !== "changed" || (f.kind !== "stem" && f.kind !== "bounce")) continue;
        const [pa, pb] = await Promise.all([peaksOf(deps.db, f.before!.hash), peaksOf(deps.db, f.after!.hash)]);
        audioRows.push(html`<div class="stem-diff"><h3>${f.name}</h3><div class="two">${miniWave(pa?.peaks ?? [], "Before")}${miniWave(pb?.peaks ?? [], "After")}</div></div>`);
      }
      const bouncesA = fa.find((f) => f.kind === "bounce");
      const bouncesB = fb.find((f) => f.kind === "bounce");
      let ab: Html = html``;
      if (bouncesA && bouncesB && bouncesA.hash !== bouncesB.hash) {
        const [pa, pb] = await Promise.all([peaksOf(deps.db, bouncesA.hash), peaksOf(deps.db, bouncesB.hash)]);
        ab = player(
          [
            { name: "Before", src: `${base}/c/${before.id}/f/${bouncesA.position}?play=1`, peaks: pa?.peaks ?? [], durationMs: pa?.durationMs ?? 0 },
            { name: "After", src: `${base}/c/${after.id}/f/${bouncesB.position}?play=1`, peaks: pb?.peaks ?? [], durationMs: pb?.durationMs ?? 0 }
          ],
          { title: "Hear the difference", mode: "ab", note: html`<p class="muted">Both play together; switch between A and B and it keeps your place in the song.</p>` }
        );
      }
      const word = { added: "New", removed: "Removed", changed: "Changed", same: "Same" } as const;
      return render(
        req,
        reply,
        deps,
        { title: `What changed · ${a.project.name}`, styles: ["/static/projects.css", "/static/player.css", "/static/view.css", "/static/diff.css"], scripts: ["/static/player.mjs"] },
        html`${head}
${ab}
<section class="panel"><h2>Inside the project</h2>${structural}</section>
${overlay}
<section class="panel"><h2>Audio and files</h2>
<ul class="files">${files.map((f) => html`<li class="file-${f.what}"><span class="badge badge-${f.what}">${word[f.what]}</span><span class="file-name">${f.name}</span><span class="muted">${f.kind === "stem" ? "Instrument track" : f.kind === "bounce" ? "Full song" : f.kind === "project" ? "Project file" : "Samples zip"}</span><span></span></li>`)}</ul>
${audioRows.length ? html`<h3>Changed audio, side by side</h3>${audioRows}` : ""}
</section>`
      );
    });
  }
};

export default diff;
