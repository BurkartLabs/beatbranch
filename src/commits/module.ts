import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { refuse, render, type Deps, type Module } from "../app.js";
import { blobStore, DiskBlobStore, type BlobStore } from "../blobs/store.js";
import { RATE_LIMITS, retryAfterSeconds, retryWords, takeLimit } from "../limits/limits.js";
import { access, branchesOf, type Access } from "../projects/repo.js";
import { projectPath } from "../projects/views.js";
import { html, type Html } from "../web/html.js";
import { afterCommit } from "./after.js";
import { cleanName, judge, MAX_FILE_BYTES, MAX_STEMS, type FileKind } from "./files.js";
import { createCommit, filesOf, getCommit, newBytesFor, usedBytes, type StagedFile } from "./repo.js";
import { commitView } from "./views.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });
const CommitParams = Params.extend({ id: z.string().max(40) });
const FileParams = CommitParams.extend({ pos: z.coerce.number().int().min(0).max(1000) });
const FIELD_KINDS: Record<string, FileKind> = { project: "project", stems: "stem", bounce: "bounce", samples: "samples" };

export const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

async function find(req: FastifyRequest, deps: Deps, params: { handle: string; slug: string }): Promise<Access | null> {
  return access(deps.db, params.handle, params.slug, req.user);
}

function commitForm(a: Access, branches: string[], branch: string, csrf: string, used: number, quota: number): Html {
  const p = a.project;
  const accept = p.daw === "fl-studio" ? ".flp,.zip" : p.daw === "ableton" ? ".als,.zip" : p.daw === "reaper" ? ".rpp,.zip" : p.daw === "studio-one" ? ".song,.zip" : p.daw === "bitwig" ? ".bwproject,.zip" : p.daw === "logic" ? ".zip" : ".flp,.als,.rpp,.song,.bwproject,.zip";
  return html`<section class="panel narrow">
  <p class="muted crumbs"><a href="${projectPath(p)}">${p.name}</a></p>
  <h1>New commit</h1>
  <form method="post" action="${projectPath(p)}/commit" enctype="multipart/form-data">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="branch">Branch</label>
    <select id="branch" name="branch">${branches.map((b) => html`<option value="${b}"${b === branch ? html` selected` : ""}>${b}</option>`)}</select>
    <label for="message">Message</label>
    <textarea id="message" name="message" required maxlength="1000" placeholder="brought the bass down, new hat pattern"></textarea>
    <label for="project">Project file</label>
    <input id="project" name="project" type="file" required accept="${accept}">
    <p class="hint">${p.daw === "logic" ? "Zip the .logicx package first." : "The file your DAW saves, or its zipped package with samples."}</p>
    <label for="stems">Stems</label>
    <input id="stems" name="stems" type="file" multiple accept=".wav,.flac,.aif,.aiff">
    <p class="hint">One WAV or FLAC per track, optional.</p>
    <label for="bounce">Bounce</label>
    <input id="bounce" name="bounce" type="file" accept=".wav,.flac,.aif,.aiff,.mp3">
    <label for="samples">Sample bundle</label>
    <input id="samples" name="samples" type="file" accept=".zip">
    <p class="hint">Storage used: ${mb(used)} of ${mb(quota)}. A file you already uploaded counts once.</p>
    <div class="actions"><button type="submit" class="button primary">Commit</button><a class="button quiet" href="${projectPath(p)}">Cancel</a></div>
  </form>
</section>`;
}

class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function stage(req: FastifyRequest, deps: Deps, a: Access, dir: string): Promise<{ branch: string; message: string; files: StagedFile[]; temps: Map<string, string> }> {
  let first = true;
  let branch = "main";
  let message = "";
  const files: StagedFile[] = [];
  const temps = new Map<string, string>();
  for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: MAX_STEMS + 3, fields: 8, fieldSize: 4096, parts: MAX_STEMS + 12 } })) {
    if (first) {
      first = false;
      if (part.type !== "field" || part.fieldname !== "_csrf" || part.value !== req.session!.csrfToken) throw new Refused(403, "This form has expired. Reload the page and try again. Nothing was saved.");
      continue;
    }
    if (part.type === "field") {
      if (part.fieldname === "branch") branch = String(part.value).slice(0, 80);
      if (part.fieldname === "message") message = String(part.value);
      continue;
    }
    const kind = FIELD_KINDS[part.fieldname];
    if (!kind || !part.filename) {
      part.file.resume();
      continue;
    }
    const temp = path.join(dir, crypto.randomUUID());
    const hash = crypto.createHash("sha256");
    let size = 0;
    await pipeline(
      part.file,
      new Transform({
        transform(chunk: Buffer, _e, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        }
      }),
      fs.createWriteStream(temp)
    );
    if (part.file.truncated) throw new Refused(413, `${cleanName(part.filename)} is larger than ${mb(MAX_FILE_BYTES)}.`);
    if (size === 0) continue;
    const name = cleanName(part.filename);
    const judged = judge(kind, a.project.daw, name, temp);
    if (!judged.ok) throw new Refused(400, judged.reason);
    const digest = hash.digest("hex");
    temps.set(digest, temp);
    files.push({ kind, name, hash: digest, size, contentType: judged.contentType });
  }
  if (first) throw new Refused(403, "This form has expired. Reload the page and try again. Nothing was saved.");
  return { branch, message, files, temps };
}

export function storeOf(deps: Deps): BlobStore {
  const d = deps as Deps & { blobs?: BlobStore };
  d.blobs ??= blobStore(deps.config);
  return d.blobs;
}

const commits: Module = {
  name: "commits",
  async register(app, deps) {
    app.get("/p/@:handle/:slug/commit", async (req, reply) => {
      const a = await find(req, deps, Params.parse(req.params));
      if (!a) return reply.callNotFound();
      if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the project's owner and collaborators can commit.", { href: projectPath(a.project), label: "Back to the project" });
      const branches = (await branchesOf(deps.db, a.project.id)).map((b) => b.name);
      const want = String((req.query as { branch?: string }).branch ?? "main");
      return render(req, reply, deps, { title: `Commit to ${a.project.name}`, styles: ["/static/projects.css"] }, commitForm(a, branches, branches.includes(want) ? want : "main", req.session!.csrfToken, await usedBytes(deps.db, req.user!.id), deps.config.storageQuotaBytes));
    });

    await app.register(async (scope) => {
      await scope.register(multipart, { limits: { fileSize: MAX_FILE_BYTES } });
      scope.post("/p/@:handle/:slug/commit", { bodyLimit: MAX_FILE_BYTES * 4, config: { multipart: true } }, async (req, reply) => {
        const a = await find(req, deps, Params.parse(req.params));
        if (!a) return reply.callNotFound();
        if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the project's owner and collaborators can commit.", { href: projectPath(a.project), label: "Back to the project" });
        const back = { href: `${projectPath(a.project)}/commit`, label: "Back to the form" };
        const limit = await takeLimit(deps.db, "commit", req.user!.id);
        if (!limit.ok) {
          reply.header("Retry-After", retryAfterSeconds(limit.retryAt));
          return refuse(req, reply, deps, 429, `${RATE_LIMITS.commit.says} Try again ${retryWords(limit.retryAt)}.`, back);
        }
        const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        try {
          const staged = await stage(req, deps, a, dir);
          const message = staged.message.trim().replace(/\r\n/g, "\n");
          if (!message) throw new Refused(400, "Write a commit message: what changed in this version.");
          if (message.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) throw new Refused(400, "The message must be ordinary text, at most 1000 characters.");
          const projectFiles = staged.files.filter((f) => f.kind === "project");
          if (projectFiles.length !== 1) throw new Refused(400, "A commit needs exactly one project file.");
          if (staged.files.filter((f) => f.kind === "bounce").length > 1 || staged.files.filter((f) => f.kind === "samples").length > 1) throw new Refused(400, "One bounce and one sample bundle at most.");
          const names = new Set<string>();
          for (const f of staged.files) {
            const key = `${f.kind}/${f.name}`;
            if (names.has(key)) throw new Refused(400, `${f.name} is attached twice.`);
            names.add(key);
          }
          const branches = await branchesOf(deps.db, a.project.id);
          if (!branches.some((b) => b.name === staged.branch)) throw new Refused(400, "That branch does not exist.");
          const adding = await newBytesFor(deps.db, req.user!.id, staged.files);
          const used = await usedBytes(deps.db, req.user!.id);
          if (used + adding > deps.config.storageQuotaBytes) {
            throw new Refused(413, `That would use ${mb(used + adding)} of your ${mb(deps.config.storageQuotaBytes)}. Nothing was stored.`);
          }
          const store = storeOf(deps);
          for (const [hash, temp] of staged.temps) await store.putFile(hash, temp);
          const commit = await createCommit(deps.db, { projectId: a.project.id, branchName: staged.branch, authorId: req.user!.id, message, files: staged.files, parseStatus: "pending" });
          await afterCommit(deps, a.project, commit, staged.files, staged.temps);
          return reply.redirect(`${projectPath(a.project)}/c/${commit.id}`, 303);
        } catch (error) {
          if (error instanceof Refused) return refuse(req, reply, deps, error.status, error.message, back);
          const code = (error as { code?: string }).code;
          if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") return refuse(req, reply, deps, 413, "That is more than one commit accepts.", back);
          throw error;
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    app.get("/p/@:handle/:slug/c/:id", { config: { public: true } }, async (req, reply) => {
      const params = CommitParams.parse(req.params);
      const a = await find(req, deps, params);
      if (!a) return reply.callNotFound();
      const commit = await getCommit(deps.db, a.project.id, params.id);
      if (!commit) return reply.callNotFound();
      return render(req, reply, deps, { title: `${commit.message.split("\n")[0]} · ${a.project.name}`, styles: ["/static/projects.css", "/static/player.css"], scripts: ["/static/player.js"] }, await commitView(deps, a, commit, await filesOf(deps.db, commit.id)));
    });

    app.get("/p/@:handle/:slug/c/:id/f/:pos", { config: { public: true } }, async (req, reply) => {
      const params = FileParams.parse(req.params);
      const a = await find(req, deps, params);
      if (!a) return reply.callNotFound();
      const commit = await getCommit(deps.db, a.project.id, params.id);
      if (!commit) return reply.callNotFound();
      const file = (await filesOf(deps.db, commit.id)).find((f) => f.position === params.pos);
      if (!file) return reply.callNotFound();
      const inline = (req.query as { play?: string }).play === "1" && file.contentType.startsWith("audio/");
      const url = await storeOf(deps).signedUrl(file.hash, { filename: file.name, contentType: inline ? file.contentType : "application/octet-stream", userId: req.user?.id ?? null, ttlSeconds: deps.config.blobUrlTtlSeconds, inline });
      return reply.redirect(url, 303);
    });

    app.get("/blob/:hash", { config: { public: true } }, async (req, reply) => {
      const store = storeOf(deps);
      if (!(store instanceof DiskBlobStore)) return reply.callNotFound();
      const { hash } = z.object({ hash: z.string().max(64) }).parse(req.params);
      const ok = store.verify(hash, req.query as Record<string, string>, req.user?.id ?? null);
      if (!ok || !(await store.has(hash))) return deny(reply);
      const safe = ok.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      reply.header("Content-Type", ok.contentType);
      reply.header("Content-Disposition", `${ok.inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(ok.filename)}`);
      reply.header("Cache-Control", "private, max-age=60");
      reply.header("Content-Length", String(fs.statSync(store.pathOf(hash)).size));
      return reply.send(await store.read(hash));
    });
  }
};

function deny(reply: FastifyReply) {
  return reply.code(403).type("text/plain; charset=utf-8").send("This link has expired or is not yours. Open the file again from its project.");
}

export default commits;
