import crypto from "node:crypto";
import type { Db } from "../db/db.js";
import { createProject, type Project } from "../projects/repo.js";

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const INVITE_DAYS = 14;

export async function createInvite(db: Db, projectId: string, role: "collaborator" | "listener", by: string, now = Date.now()): Promise<string> {
  const token = crypto.randomBytes(24).toString("base64url");
  await db.run("INSERT INTO invites (id, project_id, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    crypto.randomUUID(), projectId, role, hash(token), by, now, now + INVITE_DAYS * 86400000
  ]);
  return token;
}

export interface InviteView {
  id: string;
  projectId: string;
  role: "collaborator" | "listener";
  projectName: string;
  ownerHandle: string;
  slug: string;
  expired: boolean;
  used: boolean;
}

export async function findInvite(db: Db, token: string, now = Date.now()): Promise<InviteView | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const r = await db.get<{ id: string; project_id: string; role: "collaborator" | "listener"; name: string; handle: string; slug: string; expires_at: number; accepted_at: number | null }>(
    "SELECT i.id, i.project_id, i.role, p.name, u.handle, p.slug, i.expires_at, i.accepted_at FROM invites i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = p.owner_id WHERE i.token_hash = ?",
    [hash(token)]
  );
  if (!r) return null;
  return { id: r.id, projectId: r.project_id, role: r.role, projectName: r.name, ownerHandle: r.handle, slug: r.slug, expired: Number(r.expires_at) < now, used: r.accepted_at !== null };
}

export async function acceptInvite(db: Db, token: string, userId: string, now = Date.now()): Promise<InviteView | null> {
  return db.transaction(async () => {
    const inv = await findInvite(db, token, now);
    if (!inv || inv.expired || inv.used) return null;
    await db.run("UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL", [userId, now, inv.id]);
    const existing = await db.get<{ role: string }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", [inv.projectId, userId]);
    if (!existing) await db.run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)", [inv.projectId, userId, inv.role, now]);
    else if (existing.role === "listener" && inv.role === "collaborator") await db.run("UPDATE project_members SET role = 'collaborator' WHERE project_id = ? AND user_id = ?", [inv.projectId, userId]);
    await db.run("UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?", [now, userId]);
    return inv;
  });
}

export async function members(db: Db, projectId: string): Promise<{ userId: string; handle: string; name: string; role: string }[]> {
  const rows = await db.all<{ user_id: string; handle: string; display_name: string; role: string }>(
    "SELECT m.user_id, u.handle, u.display_name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'collaborator' THEN 1 ELSE 2 END, u.display_name",
    [projectId]
  );
  return rows.map((r) => ({ userId: r.user_id, handle: r.handle, name: r.display_name, role: r.role }));
}

export async function isVerified(db: Db, userId: string): Promise<boolean> {
  return !!(await db.get("SELECT 1 AS x FROM users WHERE id = ? AND verified_at IS NOT NULL", [userId]));
}

export async function fork(db: Db, source: Project, userId: string, now = Date.now()): Promise<Project> {
  const copy = await createProject(db, userId, { name: source.name, visibility: "public", daw: source.daw, genre: source.genre, subgenre: source.subgenre, description: source.description, state: source.state, bpm: source.bpm ?? "", musicalKey: source.musicalKey }, now);
  await db.transaction(async () => {
    await db.run("DELETE FROM branches WHERE project_id = ?", [copy.id]);
    const commits = await db.all<{ id: string; branch_id: string; parent_id: string | null; parent2_id: string | null; author_id: string | null; message: string; parse_status: string; model_json: unknown; created_at: number }>(
      "SELECT id, branch_id, parent_id, parent2_id, author_id, message, parse_status, model_json, created_at FROM commits WHERE project_id = ? ORDER BY created_at, id",
      [source.id]
    );
    const branches = await db.all<{ id: string; name: string; head_commit_id: string | null; created_at: number; deleted_at: number | null }>("SELECT id, name, head_commit_id, created_at, deleted_at FROM branches WHERE project_id = ?", [source.id]);
    const ids = new Map<string, string>();
    for (const c of commits) ids.set(c.id, crypto.randomUUID());
    const bids = new Map<string, string>();
    for (const b of branches) {
      const id = crypto.randomUUID();
      bids.set(b.id, id);
      await db.run("INSERT INTO branches (id, project_id, name, head_commit_id, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)", [id, copy.id, b.name, b.created_at, b.deleted_at]);
    }
    if (!branches.some((b) => b.name === "main" && b.deleted_at === null)) await db.run("INSERT INTO branches (id, project_id, name, created_at) VALUES (?, ?, 'main', ?)", [crypto.randomUUID(), copy.id, now]);
    for (const c of commits) {
      await db.run("INSERT INTO commits (id, project_id, branch_id, parent_id, parent2_id, author_id, message, parse_status, model_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        ids.get(c.id)!, copy.id, bids.get(c.branch_id)!, c.parent_id ? ids.get(c.parent_id) ?? null : null, c.parent2_id ? ids.get(c.parent2_id) ?? null : null, c.author_id, c.message, c.parse_status, c.model_json === null ? null : JSON.stringify(c.model_json), c.created_at
      ]);
      await db.run("INSERT INTO commit_files (commit_id, kind, name, blob_hash, size, content_type, position) SELECT ?, kind, name, blob_hash, size, content_type, position FROM commit_files WHERE commit_id = ?", [ids.get(c.id)!, c.id]);
      await db.run("INSERT INTO commit_previews (commit_id, blob_hash, reason, created_at) SELECT ?, blob_hash, reason, created_at FROM commit_previews WHERE commit_id = ?", [ids.get(c.id)!, c.id]);
    }
    for (const b of branches) if (b.head_commit_id) await db.run("UPDATE branches SET head_commit_id = ? WHERE id = ?", [ids.get(b.head_commit_id)!, bids.get(b.id)!]);
    const mainHead = branches.find((b) => b.name === "main" && b.deleted_at === null)?.head_commit_id ?? null;
    await db.run("UPDATE projects SET forked_from = ?, forked_from_commit = ? WHERE id = ?", [source.id, mainHead, copy.id]);
    await db.run("INSERT INTO project_tags (project_id, tag) SELECT ?, tag FROM project_tags WHERE project_id = ? ON CONFLICT DO NOTHING", [copy.id, source.id]);
  });
  return copy;
}

export async function forkInfo(db: Db, projectId: string): Promise<{ source: { name: string; handle: string; slug: string; visible: boolean } | null; forks: { name: string; handle: string; slug: string }[] }> {
  const src = await db.get<{ name: string; handle: string; slug: string; visibility: string; hidden_at: number | null }>(
    "SELECT s.name, u.handle, s.slug, s.visibility, s.hidden_at FROM projects p JOIN projects s ON s.id = p.forked_from JOIN users u ON u.id = s.owner_id WHERE p.id = ?",
    [projectId]
  );
  const forks = await db.all<{ name: string; handle: string; slug: string }>(
    "SELECT p.name, u.handle, p.slug FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.forked_from = ? AND p.visibility = 'public' AND p.hidden_at IS NULL ORDER BY p.created_at DESC LIMIT 50",
    [projectId]
  );
  return { source: src ? { name: src.name, handle: src.handle, slug: src.slug, visible: src.visibility !== "private" && src.hidden_at === null } : null, forks };
}

export async function latestRelease(db: Db, projectId: string): Promise<{ id: string; name: string; commitId: string; createdAt: number } | null> {
  const r = await db.get<{ id: string; name: string; commit_id: string; created_at: number }>("SELECT id, name, commit_id, created_at FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId]);
  return r ? { id: r.id, name: r.name, commitId: r.commit_id, createdAt: Number(r.created_at) } : null;
}

export async function activityFor(db: Db, userId: string, limit = 50) {
  return db.all<{ kind: string; at: number; project_name: string; handle: string; slug: string; commit_id: string; message: string; who: string | null; who_handle: string | null }>(
    `SELECT * FROM (
       SELECT 'save' AS kind, c.created_at AS at, p.name AS project_name, o.handle, p.slug, c.id AS commit_id, c.message, a.display_name AS who, a.handle AS who_handle
       FROM commits c JOIN projects p ON p.id = c.project_id JOIN users o ON o.id = p.owner_id JOIN project_members m ON m.project_id = p.id AND m.user_id = ? LEFT JOIN users a ON a.id = c.author_id
       UNION ALL
       SELECT 'comment', k.created_at, p.name, o.handle, p.slug, k.commit_id, k.body, a.display_name, a.handle
       FROM comments k JOIN projects p ON p.id = k.project_id JOIN users o ON o.id = p.owner_id JOIN project_members m ON m.project_id = p.id AND m.user_id = ? LEFT JOIN users a ON a.id = k.author_id
     ) x ORDER BY at DESC LIMIT ?`,
    [userId, userId, limit]
  );
}
