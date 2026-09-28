// Projects: creating one (with its main branch and its owner as a member, in one transaction: AB#2747, AB#2913),
// finding one by its address, and who may see or change it (AB#2780). Every read of a project goes through
// `access()`, so the visibility rule lives in one place (T-003) and the two-account probe (AB#3765) has one seam.
import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { DAW_IDS, knownGenre, STATE_IDS, VISIBILITY_IDS, type DawId, type StateId, type Visibility } from "./catalogue.js";

export interface Project {
  id: string;
  ownerId: string;
  ownerHandle: string;
  ownerName: string;
  slug: string;
  name: string;
  visibility: Visibility;
  daw: DawId;
  genre: string;
  subgenre: string;
  description: string;
  state: StateId;
  bpm: number | null;
  musicalKey: string;
  hiddenAt: number | null;
  hiddenReason: string;
  createdAt: number;
  updatedAt: number;
}

export type Role = "owner" | "collaborator" | "listener";

/** What the asker may do with a project: nothing (it does not exist for them), look, or change it. */
export interface Access {
  project: Project;
  /** The asker's membership, if any. */
  role: Role | null;
  admin: boolean;
  canEdit: boolean;
}

const Text = (max: number) => z.string().trim().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), "ordinary text only");

export const NewProject = z
  .object({
    name: Text(120).pipe(z.string().min(1, "Give the project a name.")),
    visibility: z.enum(VISIBILITY_IDS),
    daw: z.enum(DAW_IDS),
    genre: Text(40).default(""),
    subgenre: Text(40).default(""),
    description: Text(2000).default(""),
    state: z.enum(STATE_IDS).default("idea"),
    /** Comma-separated in the form; stored one per row, lower-cased, at most 12. */
    tags: z.string().max(400).default(""),
    bpm: z.union([z.literal(""), z.coerce.number().int().min(20).max(999)]).default(""),
    musicalKey: Text(12).default("")
  })
  .refine((p) => knownGenre(p.genre, p.subgenre), { path: ["genre"], message: "Pick a genre from the list." });
export type NewProjectInput = z.input<typeof NewProject>;

/** A URL slug from a name: lower-case, letters, digits and single hyphens; "untitled" if nothing survives. */
export function slugOf(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "untitled";
}

/** The tags a form gave: split on commas, trimmed, lower-cased, de-duplicated, at most 12 of at most 30 characters. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === 12) break;
  }
  return out;
}

type ProjectRow = {
  id: string; owner_id: string; owner_handle: string; owner_name: string; slug: string; name: string; visibility: Visibility; daw: DawId;
  genre: string; subgenre: string; description: string; state: StateId; bpm: number | null; musical_key: string;
  hidden_at: number | null; hidden_reason: string; created_at: number; updated_at: number;
};
const SELECT = `SELECT p.id, p.owner_id, u.handle AS owner_handle, u.display_name AS owner_name, p.slug, p.name, p.visibility, p.daw, p.genre, p.subgenre,
  p.description, p.state, p.bpm, p.musical_key, p.hidden_at, p.hidden_reason, p.created_at, p.updated_at FROM projects p JOIN users u ON u.id = p.owner_id`;
const toProject = (r: ProjectRow): Project => ({
  id: r.id, ownerId: r.owner_id, ownerHandle: r.owner_handle, ownerName: r.owner_name, slug: r.slug, name: r.name, visibility: r.visibility, daw: r.daw,
  genre: r.genre, subgenre: r.subgenre, description: r.description, state: r.state, bpm: r.bpm === null ? null : Number(r.bpm), musicalKey: r.musical_key,
  hiddenAt: r.hidden_at === null ? null : Number(r.hidden_at), hiddenReason: r.hidden_reason, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)
});

/** Create the project, its main branch and its owner's membership together (AB#2913: every project starts with main). */
export async function createProject(db: Db, ownerId: string, input: NewProjectInput, now = Date.now()): Promise<Project> {
  const p = NewProject.parse(input);
  const id = crypto.randomUUID();
  const base = slugOf(p.name);
  return db.transaction(async () => {
    // A slug the owner already uses gets a number: "night-drive", "night-drive-2", ...
    const taken = new Set((await db.all<{ slug: string }>("SELECT slug FROM projects WHERE owner_id = ? AND (slug = ? OR slug LIKE ?)", [ownerId, base, `${base}-%`])).map((r) => r.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    await db.run(
      "INSERT INTO projects (id, owner_id, slug, name, visibility, daw, genre, subgenre, description, state, bpm, musical_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, ownerId, slug, p.name, p.visibility, p.daw, p.genre, p.subgenre, p.description, p.state, p.bpm === "" ? null : p.bpm, p.musicalKey, now, now]
    );
    await db.run("INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)", [id, ownerId, now]);
    await db.run("INSERT INTO branches (id, project_id, name, created_at) VALUES (?, ?, 'main', ?)", [crypto.randomUUID(), id, now]);
    for (const tag of parseTags(p.tags)) await db.run("INSERT INTO project_tags (project_id, tag) VALUES (?, ?)", [id, tag]);
    const row = await db.get<ProjectRow>(`${SELECT} WHERE p.id = ?`, [id]);
    return toProject(row!);
  });
}

async function memberRole(db: Db, projectId: string, userId: string | undefined): Promise<Role | null> {
  if (!userId) return null;
  const r = await db.get<{ role: Role }>("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", [projectId, userId]);
  return r?.role ?? null;
}

/**
 * The project at /p/@handle/slug as the asker may see it, or null: a private project, or one an admin has hidden,
 * does not exist for a non-member (AB#2780: "a private project 404s for a non-member").
 */
export async function access(db: Db, handle: string, slug: string, asker: { id: string; role: "producer" | "admin" } | null): Promise<Access | null> {
  const row = await db.get<ProjectRow>(`${SELECT} WHERE u.handle = ? AND p.slug = ?`, [handle.toLowerCase(), slug]);
  if (!row) return null;
  const project = toProject(row);
  const role = await memberRole(db, project.id, asker?.id);
  const admin = asker?.role === "admin";
  const member = role !== null;
  if (project.visibility === "private" && !member && !admin) return null;
  if (project.hiddenAt !== null && !member && !admin) return null;
  return { project, role, admin, canEdit: role === "owner" || role === "collaborator" };
}

export async function tagsOf(db: Db, projectId: string): Promise<string[]> {
  return (await db.all<{ tag: string }>("SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag", [projectId])).map((r) => r.tag);
}

/** The projects this user owns or belongs to, most recently changed first. */
export async function listMine(db: Db, userId: string): Promise<Project[]> {
  const rows = await db.all<ProjectRow>(`${SELECT} JOIN project_members m ON m.project_id = p.id AND m.user_id = ? ORDER BY p.updated_at DESC`, [userId]);
  return rows.map(toProject);
}

/** Public, not hidden, most recently changed first: the explore list. Unlisted projects are never here (AB#2780). */
export async function listPublic(db: Db, limit = 60): Promise<Project[]> {
  const rows = await db.all<ProjectRow>(`${SELECT} WHERE p.visibility = 'public' AND p.hidden_at IS NULL ORDER BY p.updated_at DESC LIMIT ?`, [limit]);
  return rows.map(toProject);
}

/** A producer's public projects, for their page (unlisted and private ones stay off it). */
export async function listPublicOf(db: Db, ownerId: string): Promise<Project[]> {
  const rows = await db.all<ProjectRow>(`${SELECT} WHERE p.owner_id = ? AND p.visibility = 'public' AND p.hidden_at IS NULL ORDER BY p.updated_at DESC`, [ownerId]);
  return rows.map(toProject);
}

export interface Branch {
  id: string;
  name: string;
  headCommitId: string | null;
  createdAt: number;
}

export async function branchesOf(db: Db, projectId: string): Promise<Branch[]> {
  const rows = await db.all<{ id: string; name: string; head_commit_id: string | null; created_at: number }>(
    "SELECT id, name, head_commit_id, created_at FROM branches WHERE project_id = ? AND deleted_at IS NULL ORDER BY CASE WHEN name = 'main' THEN 0 ELSE 1 END, name",
    [projectId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, headCommitId: r.head_commit_id, createdAt: Number(r.created_at) }));
}
