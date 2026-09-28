import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { ancestors } from "../commits/repo.js";
import type { Branch } from "../projects/repo.js";

export const BranchName = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\s+/g, "-"))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "Use 1 to 40 letters, numbers or dashes."));

export async function findBranch(db: Db, projectId: string, name: string): Promise<Branch | null> {
  const r = await db.get<{ id: string; name: string; head_commit_id: string | null; created_at: number }>(
    "SELECT id, name, head_commit_id, created_at FROM branches WHERE project_id = ? AND name = ? AND deleted_at IS NULL",
    [projectId, name]
  );
  return r ? { id: r.id, name: r.name, headCommitId: r.head_commit_id, createdAt: Number(r.created_at) } : null;
}

export type CreateResult = { ok: true; branch: Branch } | { ok: false; reason: string };

export async function createBranch(db: Db, projectId: string, rawName: string, fromCommitId: string | null, now = Date.now()): Promise<CreateResult> {
  const parsed = BranchName.safeParse(rawName);
  if (!parsed.success) return { ok: false, reason: "Give the idea a short name: letters, numbers or dashes." };
  const name = parsed.data;
  return db.transaction(async () => {
    if (await findBranch(db, projectId, name)) return { ok: false, reason: "An idea with that name already exists." } as const;
    if (fromCommitId !== null) {
      const c = await db.get("SELECT 1 AS x FROM commits WHERE id = ? AND project_id = ?", [fromCommitId, projectId]);
      if (!c) return { ok: false, reason: "That save is not in this project." } as const;
    }
    const id = crypto.randomUUID();
    await db.run("INSERT INTO branches (id, project_id, name, head_commit_id, created_from, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, projectId, name, fromCommitId, fromCommitId, now]);
    return { ok: true, branch: { id, name, headCommitId: fromCommitId, createdAt: now } } as const;
  });
}

export async function divergence(db: Db, branchHead: string | null, mainHead: string | null): Promise<{ ahead: number; behind: number }> {
  const [a, m] = await Promise.all([ancestors(db, branchHead), ancestors(db, mainHead)]);
  let ahead = 0;
  let behind = 0;
  for (const id of a) if (!m.has(id)) ahead++;
  for (const id of m) if (!a.has(id)) behind++;
  return { ahead, behind };
}

export type DeleteResult = { ok: true } | { ok: false; reason: string; unmerged?: number };

export async function deleteBranch(db: Db, projectId: string, name: string, abandon: boolean, now = Date.now()): Promise<DeleteResult> {
  if (name === "main") return { ok: false, reason: "The Main version can't be deleted." };
  const branch = await findBranch(db, projectId, name);
  if (!branch) return { ok: false, reason: "That idea doesn't exist." };
  const main = await findBranch(db, projectId, "main");
  const { ahead } = await divergence(db, branch.headCommitId, main?.headCommitId ?? null);
  if (ahead > 0 && !abandon) return { ok: false, reason: "This idea has saves the Main version doesn't have.", unmerged: ahead };
  await db.run("UPDATE branches SET deleted_at = ? WHERE id = ?", [now, branch.id]);
  return { ok: true };
}

export interface GraphNode {
  id: string;
  branchName: string;
  branchId: string;
  parentId: string | null;
  parent2Id: string | null;
  message: string;
  createdAt: number;
}

export async function graphOf(db: Db, projectId: string, limit = 300): Promise<GraphNode[]> {
  const rows = await db.all<{ id: string; branch_name: string; branch_id: string; parent_id: string | null; parent2_id: string | null; message: string; created_at: number }>(
    `SELECT c.id, b.name AS branch_name, b.id AS branch_id, c.parent_id, c.parent2_id, c.message, c.created_at FROM commits c JOIN branches b ON b.id = c.branch_id
     WHERE c.project_id = ? ORDER BY c.created_at DESC, c.id LIMIT ?`,
    [projectId, limit]
  );
  return rows.map((r) => ({ id: r.id, branchName: r.branch_name, branchId: r.branch_id, parentId: r.parent_id, parent2Id: r.parent2_id, message: r.message, createdAt: Number(r.created_at) }));
}
