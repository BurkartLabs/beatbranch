import crypto from "node:crypto";
import type { Db } from "../db/db.js";
import type { FileKind } from "./files.js";

export interface StagedFile {
  kind: FileKind;
  name: string;
  hash: string;
  size: number;
  contentType: string;
}

export interface Commit {
  id: string;
  projectId: string;
  branchId: string;
  branchName: string;
  parentId: string | null;
  parent2Id: string | null;
  authorId: string | null;
  authorHandle: string | null;
  authorName: string | null;
  message: string;
  parseStatus: "pending" | "ok" | "failed" | "unsupported";
  createdAt: number;
}

export interface CommitFile {
  kind: FileKind;
  name: string;
  hash: string;
  size: number;
  contentType: string;
  position: number;
}

type CommitRow = { id: string; project_id: string; branch_id: string; branch_name: string; parent_id: string | null; parent2_id: string | null; author_id: string | null; author_handle: string | null; author_name: string | null; message: string; parse_status: Commit["parseStatus"]; created_at: number };
const SELECT = `SELECT c.id, c.project_id, c.branch_id, b.name AS branch_name, c.parent_id, c.parent2_id, c.author_id, u.handle AS author_handle, u.display_name AS author_name, c.message, c.parse_status, c.created_at
  FROM commits c JOIN branches b ON b.id = c.branch_id LEFT JOIN users u ON u.id = c.author_id`;
const toCommit = (r: CommitRow): Commit => ({
  id: r.id, projectId: r.project_id, branchId: r.branch_id, branchName: r.branch_name, parentId: r.parent_id, parent2Id: r.parent2_id,
  authorId: r.author_id, authorHandle: r.author_handle, authorName: r.author_name, message: r.message, parseStatus: r.parse_status, createdAt: Number(r.created_at)
});

export async function usedBytes(db: Db, userId: string): Promise<number> {
  const r = await db.get<{ n: number | null }>("SELECT COALESCE(SUM(b.size), 0) AS n FROM account_blobs a JOIN blobs b ON b.hash = a.blob_hash WHERE a.user_id = ?", [userId]);
  return Number(r?.n ?? 0);
}

export async function newBytesFor(db: Db, userId: string, files: { hash: string; size: number }[]): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (seen.has(f.hash)) continue;
    seen.add(f.hash);
    const owned = await db.get("SELECT 1 AS x FROM account_blobs WHERE user_id = ? AND blob_hash = ?", [userId, f.hash]);
    if (!owned) total += f.size;
  }
  return total;
}

export class BranchMoved extends Error {}

export async function createCommit(
  db: Db,
  input: { projectId: string; branchName: string; authorId: string; message: string; files: StagedFile[]; parseStatus: Commit["parseStatus"]; parent2Id?: string | null; expectedHead?: string | null; now?: number }
): Promise<Commit> {
  const now = input.now ?? Date.now();
  const id = crypto.randomUUID();
  return db.transaction(async () => {
    const branch = await db.get<{ id: string; head_commit_id: string | null }>("SELECT id, head_commit_id FROM branches WHERE project_id = ? AND name = ? AND deleted_at IS NULL FOR UPDATE", [input.projectId, input.branchName]);
    if (!branch) throw new Error("no such branch");
    if (input.expectedHead !== undefined && branch.head_commit_id !== input.expectedHead) throw new BranchMoved();
    for (const f of input.files) {
      await db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING", [f.hash, f.size, now]);
      await db.run("INSERT INTO account_blobs (user_id, blob_hash, added_at) VALUES (?, ?, ?) ON CONFLICT (user_id, blob_hash) DO NOTHING", [input.authorId, f.hash, now]);
    }
    await db.run("INSERT INTO commits (id, project_id, branch_id, parent_id, parent2_id, author_id, message, parse_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id, input.projectId, branch.id, branch.head_commit_id, input.parent2Id ?? null, input.authorId, input.message, input.parseStatus, now
    ]);
    let position = 0;
    for (const f of input.files) {
      await db.run("INSERT INTO commit_files (commit_id, kind, name, blob_hash, size, content_type, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, f.kind, f.name, f.hash, f.size, f.contentType, position++]);
    }
    await db.run("UPDATE branches SET head_commit_id = ? WHERE id = ?", [id, branch.id]);
    await db.run("UPDATE projects SET updated_at = ? WHERE id = ?", [now, input.projectId]);
    return toCommit((await db.get<CommitRow>(`${SELECT} WHERE c.id = ?`, [id]))!);
  });
}

export async function history(db: Db, headId: string | null, limit = 200): Promise<Commit[]> {
  if (!headId) return [];
  const rows = await db.all<CommitRow & { depth: number }>(
    `WITH RECURSIVE chain(id, depth) AS (SELECT CAST(? AS TEXT), 0 UNION ALL SELECT c.parent_id, chain.depth + 1 FROM commits c JOIN chain ON c.id = chain.id WHERE c.parent_id IS NOT NULL AND chain.depth < ?)
     ${SELECT} JOIN chain ON chain.id = c.id ORDER BY chain.depth`,
    [headId, limit - 1]
  );
  return rows.map(toCommit);
}

export async function ancestors(db: Db, headId: string | null): Promise<Set<string>> {
  if (!headId) return new Set();
  const rows = await db.all<{ id: string }>(
    `WITH RECURSIVE a(id) AS (SELECT CAST(? AS TEXT) UNION SELECT p.pid FROM a JOIN (SELECT id, parent_id AS pid FROM commits WHERE parent_id IS NOT NULL UNION ALL SELECT id, parent2_id AS pid FROM commits WHERE parent2_id IS NOT NULL) p ON p.id = a.id) SELECT id FROM a`,
    [headId]
  );
  return new Set(rows.map((r) => r.id));
}

export async function getCommit(db: Db, projectId: string, commitId: string): Promise<Commit | null> {
  if (!/^[0-9a-f-]{36}$/.test(commitId)) return null;
  const r = await db.get<CommitRow>(`${SELECT} WHERE c.id = ? AND c.project_id = ?`, [commitId, projectId]);
  return r ? toCommit(r) : null;
}

export async function filesOf(db: Db, commitId: string): Promise<CommitFile[]> {
  const rows = await db.all<{ kind: FileKind; name: string; blob_hash: string; size: number; content_type: string; position: number }>(
    "SELECT kind, name, blob_hash, size, content_type, position FROM commit_files WHERE commit_id = ? ORDER BY CASE kind WHEN 'project' THEN 0 WHEN 'bounce' THEN 1 WHEN 'stem' THEN 2 ELSE 3 END, position",
    [commitId]
  );
  return rows.map((r) => ({ kind: r.kind, name: r.name, hash: r.blob_hash, size: Number(r.size), contentType: r.content_type, position: Number(r.position) }));
}

export async function setModel(db: Db, commitId: string, status: Commit["parseStatus"], model: unknown): Promise<void> {
  await db.run("UPDATE commits SET parse_status = ?, model_json = ? WHERE id = ?", [status, model === null ? null : JSON.stringify(model), commitId]);
}

export async function modelOf(db: Db, commitId: string): Promise<unknown> {
  const r = await db.get<{ model_json: unknown }>("SELECT model_json FROM commits WHERE id = ?", [commitId]);
  return r?.model_json ?? null;
}
