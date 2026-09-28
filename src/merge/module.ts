import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { refuse, render, type Deps, type Module } from "../app.js";
import { findBranch } from "../branches/repo.js";
import { afterCommit } from "../commits/after.js";
import { storeOf } from "../commits/module.js";
import { ancestors, BranchMoved, createCommit, filesOf, getCommit, type StagedFile } from "../commits/repo.js";
import { access, type Access } from "../projects/repo.js";
import { projectPath } from "../projects/views.js";
import { isVerified } from "../social/repo.js";
import { html } from "../web/html.js";
import { ideaName } from "../web/words.js";
import { choicesFor, mergeAls, mergeRpp, type Pick } from "./writers.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });

async function readBlob(deps: Deps, hash: string): Promise<Buffer> {
  const stream = await storeOf(deps).read(hash);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

function writerFormat(name: string): "als" | "rpp" | null {
  const ext = name.toLowerCase().split(".").pop();
  return ext === "als" ? "als" : ext === "rpp" ? "rpp" : null;
}

async function setup(deps: Deps, a: Access, from: string) {
  const idea = await findBranch(deps.db, a.project.id, from);
  const main = await findBranch(deps.db, a.project.id, "main");
  if (!idea || !main || idea.name === "main" || !idea.headCommitId) return null;
  const ideaHead = (await getCommit(deps.db, a.project.id, idea.headCommitId))!;
  const mainHead = main.headCommitId ? await getCommit(deps.db, a.project.id, main.headCommitId) : null;
  const fastForward = !mainHead || (await ancestors(deps.db, idea.headCommitId)).has(mainHead.id);
  const already = !!mainHead && (await ancestors(deps.db, mainHead.id)).has(idea.headCommitId);
  return { idea, main, ideaHead, mainHead, fastForward, already };
}

const merge: Module = {
  name: "merge",
  register(app, deps: Deps) {
    app.get("/p/@:handle/:slug/merge", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change the Main version.", { href: base, label: "Back" });
      const from = String((req.query as { from?: string }).from ?? "").slice(0, 60);
      const s = await setup(deps, a, from);
      if (!s) return refuse(req, reply, deps, 400, "Pick an idea that has at least one save.", { href: `${base}/branches`, label: "Back to ideas" });
      const csrf = req.session!.csrfToken;
      if (s.already) return render(req, reply, deps, { title: "Nothing to bring in" }, html`<section class="panel narrow"><h1>Nothing new</h1><p>The Main version already has everything in ${ideaName(s.idea.name)}.</p><p><a class="button" href="${base}">Back to the song</a></p></section>`);
      const ideaFiles = await filesOf(deps.db, s.ideaHead.id);
      const mainFiles = s.mainHead ? await filesOf(deps.db, s.mainHead.id) : [];
      const ip = ideaFiles.find((f) => f.kind === "project")!;
      const mp = mainFiles.find((f) => f.kind === "project");
      const fmt = mp && writerFormat(ip.name) && writerFormat(ip.name) === writerFormat(mp.name) ? writerFormat(ip.name) : null;
      let perTrack = html`<p class="muted">Picking instruments from each isn't possible for ${a.project.daw === "fl-studio" ? "FL Studio" : "this kind of"} project: BeatBranch can only write Ableton Live and Reaper projects.</p>`;
      if (fmt && mp) {
        try {
          const choices = choicesFor(fmt, await readBlob(deps, mp.hash), await readBlob(deps, ip.hash));
          perTrack = html`<form method="post" action="${base}/merge/pick">
  <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="from" value="${s.idea.name}">
  <table class="picks"><thead><tr><th>Instrument</th><th>Main version's</th><th>The idea's</th><th>Leave out</th></tr></thead><tbody>
  ${choices.map((c, i) => html`<tr><td>${c.name}<input type="hidden" name="name${String(i)}" value="${c.name}"></td>
    <td>${c.inMain ? html`<input type="radio" name="pick${String(i)}" value="main" aria-label="${c.name}: Main version's"${!c.inIdea || c.inMain ? html` checked` : ""}>` : ""}</td>
    <td>${c.inIdea ? html`<input type="radio" name="pick${String(i)}" value="idea" aria-label="${c.name}: the idea's"${!c.inMain ? html` checked` : ""}>` : ""}</td>
    <td><input type="radio" name="pick${String(i)}" value="none" aria-label="${c.name}: leave out"></td></tr>`)}
  </tbody></table>
  <input type="hidden" name="count" value="${String(choices.length)}">
  <div class="actions"><button class="button primary" type="submit">Make the new Main version</button></div>
</form>`;
        } catch {
          perTrack = html`<p class="muted">BeatBranch couldn't read one of the two project files, so picking instruments isn't possible here.</p>`;
        }
      }
      return render(req, reply, deps, { title: `Bring in ${s.idea.name}`, styles: ["/static/projects.css", "/static/merge.css"] }, html`<p class="muted crumbs"><a href="${base}">${a.project.name}</a></p>
<h1>Use ${ideaName(s.idea.name)} in the Main version</h1>
<p class="muted">Three ways to do it. Nothing is lost: every save stays, whichever you choose.</p>
<section class="panel"><h2>1. Use the idea as it is</h2>
<p>${s.fastForward ? "The Main version hasn't changed since the idea started, so the Main version simply becomes the idea." : "The Main version has changed since the idea started. The idea's project file replaces the Main version's, and a save records that you brought it in."}</p>
<form method="post" action="${base}/merge/take"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="from" value="${s.idea.name}"><button class="button primary" type="submit">Use the idea as it is</button></form></section>
<section class="panel"><h2>2. Pick instruments from each</h2>${perTrack}</section>
<section class="panel"><h2>3. Combine them yourself</h2>
<p>Download both project files, combine them in your music program, then upload the result. BeatBranch will remember both versions went into it.</p>
<div class="actions">${mp ? html`<a class="button" href="${base}/c/${s.mainHead!.id}/f/${mp.position}">Download the Main version</a>` : ""}<a class="button" href="${base}/c/${s.ideaHead.id}/f/${ip.position}">Download the idea</a><a class="button primary" href="${base}/commit?branch=main&merge=${s.ideaHead.id}">Upload the combined file</a></div></section>`);
    });

    app.post("/p/@:handle/:slug/merge/take", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change the Main version.", { href: base, label: "Back" });
      const s = await setup(deps, a, String((req.body as { from?: string }).from ?? "").slice(0, 60));
      if (!s || s.already) return refuse(req, reply, deps, 400, "There's nothing to bring in from that idea.", { href: `${base}/branches`, label: "Back" });
      if (s.fastForward) {
        const moved = await deps.db.run("UPDATE branches SET head_commit_id = ? WHERE id = ? AND head_commit_id IS NOT DISTINCT FROM ?", [s.ideaHead.id, s.main.id, s.mainHead?.id ?? null]);
        if (!moved) return refuse(req, reply, deps, 409, "Someone just saved to the Main version. Try again.", { href: `${base}/merge?from=${encodeURIComponent(s.idea.name)}`, label: "Try again" });
        return reply.redirect(`${base}?branch=main`, 303);
      }
      const files = (await filesOf(deps.db, s.ideaHead.id)).map((f): StagedFile => ({ kind: f.kind, name: f.name, hash: f.hash, size: f.size, contentType: f.contentType }));
      try {
        const c = await createCommit(deps.db, { projectId: a.project.id, branchName: "main", authorId: req.user!.id, message: `Brought in the idea “${s.idea.name}”`, files, parseStatus: s.ideaHead.parseStatus, parent2Id: s.ideaHead.id, expectedHead: s.mainHead?.id ?? null });
        await deps.db.run("UPDATE commits SET model_json = (SELECT model_json FROM commits WHERE id = ?) WHERE id = ?", [s.ideaHead.id, c.id]);
        await deps.db.run("INSERT INTO commit_previews (commit_id, blob_hash, reason, created_at) SELECT ?, blob_hash, reason, created_at FROM commit_previews WHERE commit_id = ? ON CONFLICT DO NOTHING", [c.id, s.ideaHead.id]);
        return reply.redirect(`${base}/c/${c.id}`, 303);
      } catch (e) {
        if (e instanceof BranchMoved) return refuse(req, reply, deps, 409, "Someone just saved to the Main version. Try again.", { href: `${base}/merge?from=${encodeURIComponent(s.idea.name)}`, label: "Try again" });
        throw e;
      }
    });

    app.post("/p/@:handle/:slug/merge/pick", async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const base = projectPath(a.project);
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change the Main version.", { href: base, label: "Back" });
      if (!(await isVerified(deps.db, req.user!.id))) return refuse(req, reply, deps, 403, "Your account is waiting to be approved before you can upload.", { href: base, label: "Back" });
      const b = req.body as Record<string, string>;
      const s = await setup(deps, a, String(b.from ?? "").slice(0, 60));
      if (!s || !s.mainHead) return refuse(req, reply, deps, 400, "There's nothing to bring in from that idea.", { href: `${base}/branches`, label: "Back" });
      const back = { href: `${base}/merge?from=${encodeURIComponent(s.idea.name)}`, label: "Back" };
      const mp = (await filesOf(deps.db, s.mainHead.id)).find((f) => f.kind === "project")!;
      const ip = (await filesOf(deps.db, s.ideaHead.id)).find((f) => f.kind === "project")!;
      const fmt = writerFormat(ip.name);
      if (!fmt || fmt !== writerFormat(mp.name)) return refuse(req, reply, deps, 400, "Picking instruments only works for Ableton Live and Reaper projects.", back);
      const count = Math.min(500, Number(b.count ?? 0));
      const picks: Pick[] = [];
      for (let i = 0; i < count; i++) {
        const choice = b[`pick${i}`];
        const name = String(b[`name${i}`] ?? "");
        if (choice === "main" || choice === "idea") picks.push({ source: choice, name });
      }
      if (!picks.length) return refuse(req, reply, deps, 400, "Pick at least one instrument.", back);
      let out: Buffer;
      try {
        const [mainBuf, ideaBuf] = [await readBlob(deps, mp.hash), await readBlob(deps, ip.hash)];
        out = fmt === "als" ? mergeAls(mainBuf, ideaBuf, picks) : mergeRpp(mainBuf, ideaBuf, picks);
      } catch (e) {
        return refuse(req, reply, deps, 400, e instanceof Error ? `That didn't work: ${e.message}.` : "That didn't work.", back);
      }
      const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      try {
        const temp = path.join(dir, mp.name);
        fs.writeFileSync(temp, out);
        const hash = crypto.createHash("sha256").update(out).digest("hex");
        await storeOf(deps).putFile(hash, temp);
        const mainSamples = (await filesOf(deps.db, s.mainHead.id)).filter((f) => f.kind === "samples");
        const files: StagedFile[] = [{ kind: "project", name: mp.name, hash, size: out.length, contentType: mp.contentType }, ...mainSamples.map((f) => ({ kind: f.kind, name: f.name, hash: f.hash, size: f.size, contentType: f.contentType }))];
        const c = await createCommit(deps.db, { projectId: a.project.id, branchName: "main", authorId: req.user!.id, message: `Picked instruments from the idea “${s.idea.name}”`, files, parseStatus: "pending", parent2Id: s.ideaHead.id, expectedHead: s.mainHead.id });
        await afterCommit(deps, a.project, c, files, new Map([[hash, temp]]));
        return reply.redirect(`${base}/c/${c.id}`, 303);
      } catch (e) {
        if (e instanceof BranchMoved) return refuse(req, reply, deps, 409, "Someone just saved to the Main version. Try again.", back);
        throw e;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
};

export default merge;
