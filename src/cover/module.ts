import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { refuse, type Deps, type Module } from "../app.js";
import { ffmpegPath } from "../audio/decode.js";
import { collectGarbage, recountAccount } from "../blobs/gc.js";
import { storeOf } from "../commits/module.js";
import { access } from "../projects/repo.js";
import { projectPath } from "../projects/views.js";

const Params = z.object({ handle: z.string().max(30), slug: z.string().max(80) });
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export const COVER_SIZE = 512;

export function imageKind(b: Buffer): "png" | "jpeg" | "webp" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export function reencode(input: string, output: string, seconds = 20): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vf", `scale=${COVER_SIZE}:${COVER_SIZE}:force_original_aspect_ratio=increase,crop=${COVER_SIZE}:${COVER_SIZE}`, "-frames:v", "1", "-map_metadata", "-1", "-c:v", "png", "-f", "image2", output], { stdio: "ignore", windowsHide: true });
    const t = setTimeout(() => p.kill("SIGKILL"), seconds * 1000);
    p.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0 && fs.existsSync(output) && imageKind(fs.readFileSync(output)) === "png");
    });
  });
}

const cover: Module = {
  name: "cover",
  async register(app, deps: Deps) {
    app.get("/p/@:handle/:slug/cover.png", { config: { public: true } }, async (req, reply) => {
      const p = Params.parse(req.params);
      const a = await access(deps.db, p.handle, p.slug, req.user);
      if (!a) return reply.callNotFound();
      const row = await deps.db.get<{ cover_blob: string | null }>("SELECT cover_blob FROM projects WHERE id = ?", [a.project.id]);
      if (!row?.cover_blob) return reply.callNotFound();
      reply.header("Content-Type", "image/png");
      reply.header("Cache-Control", "private, max-age=300");
      reply.header("Content-Disposition", "inline; filename=\"cover.png\"");
      return reply.send(await storeOf(deps).read(row.cover_blob));
    });

    await app.register(async (scope) => {
      await scope.register(multipart, { limits: { fileSize: MAX_COVER_BYTES, files: 1, fields: 2, parts: 4 } });
      scope.post("/p/@:handle/:slug/cover", { bodyLimit: MAX_COVER_BYTES + 64 * 1024, config: { multipart: true } }, async (req, reply) => {
        const p = Params.parse(req.params);
        const a = await access(deps.db, p.handle, p.slug, req.user);
        if (!a) return reply.callNotFound();
        const back = { href: `${projectPath(a.project)}/settings`, label: "Back to the details" };
        if (!a.canEdit) return refuse(req, reply, deps, 403, "Only the song's owner and collaborators can change its picture.", back);
        const dir = path.join(deps.config.dataDir, "tmp", crypto.randomUUID());
        fs.mkdirSync(dir, { recursive: true });
        try {
          let first = true;
          let input: string | null = null;
          for await (const part of req.parts()) {
            if (first) {
              first = false;
              if (part.type !== "field" || part.fieldname !== "_csrf" || part.value !== req.session!.csrfToken) return refuse(req, reply, deps, 403, "This form has expired. Reload the page and try again.", back);
              continue;
            }
            if (part.type !== "file" || part.fieldname !== "cover") {
              if (part.type === "file") part.file.resume();
              continue;
            }
            input = path.join(dir, "in");
            await pipeline(part.file, fs.createWriteStream(input));
            if (part.file.truncated) return refuse(req, reply, deps, 413, "Pictures can be up to 10 MB.", back);
          }
          if (!input) return refuse(req, reply, deps, 400, "Choose a picture first.", back);
          const head = Buffer.alloc(16);
          const fd = fs.openSync(input, "r");
          fs.readSync(fd, head, 0, 16, 0);
          fs.closeSync(fd);
          if (!imageKind(head)) return refuse(req, reply, deps, 400, "That isn't a PNG, JPEG or WebP picture.", back);
          const out = path.join(dir, "cover.png");
          if (!(await reencode(input, out))) return refuse(req, reply, deps, 400, "That picture couldn't be read.", back);
          const data = fs.readFileSync(out);
          const hash = crypto.createHash("sha256").update(data).digest("hex");
          await storeOf(deps).putFile(hash, out);
          await deps.db.transaction(async () => {
            await deps.db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", [hash, data.length, Date.now()]);
            await deps.db.run("INSERT INTO account_blobs (user_id, blob_hash, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [a.project.ownerId, hash, Date.now()]);
            await deps.db.run("UPDATE projects SET cover_blob = ?, updated_at = ? WHERE id = ?", [hash, Date.now(), a.project.id]);
          });
          await recountAccount(deps.db, a.project.ownerId);
          await collectGarbage(deps.db, storeOf(deps));
          return reply.redirect(projectPath(a.project), 303);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }
};

export default cover;
