// Create a project (AB#2747): name, visibility and DAW required; genre and subgenre from the curated list; a main
// branch from the start (AB#2913). And the seams AB#2780 will lean on: who sees what.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, SESSION_COOKIE } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createSession, createUser } from "../src/auth/users.js";
import { knownGenre } from "../src/projects/catalogue.js";
import { createProject, parseTags, slugOf } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { testDb } from "./test-db.js";
import { tempDir } from "./temp-dir.js";

let app: FastifyInstance;
let db: PostgresDb;
const ORIGIN = "http://127.0.0.1:4420";
const encode = (o: Record<string, string>) => new URLSearchParams(o).toString();

type Person = { id: string; handle: string; cookie: string; csrf: string };
async function person(handle: string): Promise<Person> {
  const made = await createUser(db, { email: `${handle}@example.com`, password: "twelve letters at least", handle, displayName: handle.toUpperCase() });
  if (!made.ok) throw new Error(made.reason);
  const { token, session } = await createSession(db, made.user.id);
  return { id: made.user.id, handle, cookie: `${SESSION_COOKIE}=${token}`, csrf: session.csrfToken };
}
const get = (url: string, who?: Person) => app.inject({ method: "GET", url, headers: { accept: "text/html", ...(who ? { cookie: who.cookie } : {}) } });
const post = (url: string, who: Person, fields: Record<string, string>) =>
  app.inject({ method: "POST", url, payload: encode({ _csrf: who.csrf, ...fields }), headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: who.cookie, accept: "text/html" } });

let alice: Person;
let bob: Person;

beforeAll(async () => {
  db = await testDb();
  app = await buildApp(loadConfig({ DATA_DIR: tempDir("bb-projects-"), LOG_LEVEL: "silent" }), db);
  alice = await person("alice");
  bob = await person("bob");
});
afterAll(async () => {
  await app.close();
});

describe("catalogue and slugs", () => {
  it("knows its genre pairs", () => {
    expect(knownGenre("", "")).toBe(true);
    expect(knownGenre("House", "")).toBe(true);
    expect(knownGenre("House", "Tech house")).toBe(true);
    expect(knownGenre("House", "Trap")).toBe(false);
    expect(knownGenre("Nope", "")).toBe(false);
  });
  it("makes URL slugs and tag lists", () => {
    expect(slugOf("Night Drive (v2) — Ünicode!")).toBe("night-drive-v2-unicode");
    expect(slugOf("!!!")).toBe("untitled");
    expect(parseTags(" 808, Dark ,808,, x ".repeat(1))).toEqual(["808", "dark", "x"]);
  });
});

describe("create a project (AB#2747, AB#2913)", () => {
  it("requires sign-in for the form", async () => {
    const r = await get("/new");
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/login?next=%2Fnew");
  });

  it("creates the project with its main branch and owner membership, and lands on its page", async () => {
    const r = await post("/new", alice, { name: "Night Drive", visibility: "public", daw: "fl-studio", genre: "House", subgenre: "Deep house", state: "sketch", bpm: "124", musicalKey: "F minor", tags: "808, night", description: "First idea." });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/p/@alice/night-drive");
    const p = await db.get<{ id: string; slug: string; bpm: number }>("SELECT id, slug, bpm FROM projects WHERE owner_id = ? AND slug = ?", [alice.id, "night-drive"]);
    expect(p?.bpm).toBe(124);
    const branches = await db.all<{ name: string; head_commit_id: string | null }>("SELECT name, head_commit_id FROM branches WHERE project_id = ?", [p!.id]);
    expect(branches).toEqual([{ name: "main", head_commit_id: null }]);
    expect(await db.get("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", [p!.id, alice.id])).toEqual({ role: "owner" });
    const tags = await db.all<{ tag: string }>("SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag", [p!.id]);
    expect(tags.map((t) => t.tag)).toEqual(["808", "night"]);
    const page = await get("/p/@alice/night-drive", alice);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Night Drive");
    expect(page.body).toContain("124 BPM");
    expect(page.body).toContain("FL Studio");
    expect(page.body).toContain("No commits yet");
    expect(page.body).toContain('<option value="main" selected>');
  });

  it("refuses a missing name, an unknown DAW, a bad visibility and a genre pair off the list, naming the field", async () => {
    const noName = await post("/new", alice, { name: "  ", visibility: "public", daw: "fl-studio" });
    expect(noName.statusCode).toBe(400);
    expect(noName.body).toContain("Give the project a name");
    const badDaw = await post("/new", alice, { name: "X", visibility: "public", daw: "garageband" });
    expect(badDaw.statusCode).toBe(400);
    expect(badDaw.body).toContain("Pick the DAW");
    const badVis = await post("/new", alice, { name: "X", visibility: "secret", daw: "ableton" });
    expect(badVis.statusCode).toBe(400);
    const badGenre = await post("/new", alice, { name: "X", visibility: "public", daw: "ableton", genre: "House", subgenre: "Trap" });
    expect(badGenre.statusCode).toBe(400);
    expect(badGenre.body).toContain("Pick a genre from the list");
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?", [alice.id])).toEqual({ n: 1 });
  });

  it("numbers a repeated name's slug per owner", async () => {
    const again = await createProject(db, alice.id, { name: "Night Drive", visibility: "private", daw: "ableton" });
    expect(again.slug).toBe("night-drive-2");
    const bobs = await createProject(db, bob.id, { name: "Night Drive", visibility: "public", daw: "reaper" });
    expect(bobs.slug).toBe("night-drive");
  });
});

describe("who sees what (the seams AB#2780 tests)", () => {
  it("a private project 404s for a stranger and for another producer, and opens for its owner", async () => {
    expect((await get("/p/@alice/night-drive-2")).statusCode).toBe(404);
    expect((await get("/p/@alice/night-drive-2", bob)).statusCode).toBe(404);
    expect((await get("/p/@alice/night-drive-2", alice)).statusCode).toBe(200);
  });

  it("an unlisted project opens by link and is not on explore or the producer's page; a public one is", async () => {
    await createProject(db, alice.id, { name: "Secret Sauce", visibility: "unlisted", daw: "fl-studio" });
    expect((await get("/p/@alice/secret-sauce", bob)).statusCode).toBe(200);
    const explore = await get("/explore");
    expect(explore.statusCode).toBe(200);
    expect(explore.body).toContain("/p/@alice/night-drive");
    expect(explore.body).toContain("/p/@bob/night-drive");
    expect(explore.body).not.toContain("secret-sauce");
    expect(explore.body).not.toContain("night-drive-2");
    const page = await get("/@alice");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("ALICE");
    expect(page.body).toContain("/p/@alice/night-drive");
    expect(page.body).not.toContain("secret-sauce");
    expect((await get("/@nobody")).statusCode).toBe(404);
  });

  it("the front door lists the signed-in producer's own projects, private ones included", async () => {
    const r = await get("/", alice);
    expect(r.body).toContain("night-drive-2");
    expect(r.body).toContain("Secret Sauce");
    expect(r.body).not.toContain("/p/@bob/");
  });
});
