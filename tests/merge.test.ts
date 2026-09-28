import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { parseAls } from "../src/parsers/als.js";
import { parseRpp } from "../src/parsers/rpp.js";
import { mergeAls, mergeRpp } from "../src/merge/writers.js";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, post, postMultipart, world, type Person } from "./helpers.js";
import { fixtureAls, fixtureRpp } from "./fixtures.js";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;

const save = async (slug: string, branch: string, name: string, data: Buffer) => {
  const r = await postMultipart(app, `/p/@alice/${slug}/commit`, alice, [{ name: "branch", value: branch }, { name: "message", value: `${branch}: ${name}` }, { name: "project", filename: name, data }]);
  expect(r.statusCode).toBe(303);
  return String(r.headers.location).split("/c/")[1]!;
};
const head = async (slug: string, branch: string) => (await db.get<{ h: string }>("SELECT b.head_commit_id AS h FROM branches b JOIN projects p ON p.id = b.project_id WHERE p.slug = ? AND b.name = ? AND b.deleted_at IS NULL", [slug, branch]))!.h;

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  await createProject(db, alice.id, { name: "Flp", visibility: "public", daw: "fl-studio" });
  await createProject(db, alice.id, { name: "Live", visibility: "public", daw: "ableton" });
  await createProject(db, alice.id, { name: "Rpp", visibility: "public", daw: "reaper" });
});
afterAll(async () => {
  await app.close();
});

describe("writers (AB#3178, AB#3197)", () => {
  it("writes an Ableton set with exactly the chosen instruments", () => {
    const out = mergeAls(fixtureAls(), fixtureAls({ extraTrack: "Keys", renameBass: "Sub" }), [{ source: "main", name: "Bass" }, { source: "idea", name: "Keys" }]);
    const m = parseAls(out);
    expect(m.tracks.map((t) => t.name)).toEqual(["Bass", "Keys", "A-Reverb"]);
    expect(m.tempo).toBe(124);
    expect(new Set(m.tracks.map((t) => t.id)).size).toBe(3);
  });
  it("writes a Reaper project with exactly the chosen tracks", () => {
    const out = mergeRpp(fixtureRpp(), fixtureRpp({ extraTrack: "Guitar" }), [{ source: "main", name: "Drums" }, { source: "idea", name: "Guitar" }]);
    const m = parseRpp(out);
    expect(m.tracks.map((t) => t.name)).toEqual(["Drums", "Guitar"]);
    expect(m.tempo).toBe(95);
    expect(out.toString("utf8").trimEnd().endsWith(">")).toBe(true);
  });
});

describe("bringing an idea into the Main version (AB#3165, 3210, 3221)", () => {
  it("fast-forwards when the Main version hasn't moved", async () => {
    const first = await save("flp", "main", "a.flp", flp("a"));
    await post(app, "/p/@alice/flp/branches", alice, { name: "try", commit: first });
    const tried = await save("flp", "try", "a.flp", flp("try"));
    const page = (await get(app, "/p/@alice/flp/merge?from=try", alice)).body;
    expect(page).toContain("simply becomes the idea");
    expect(page).toContain("isn't possible for FL Studio project");
    expect(page).not.toContain('action="/p/@alice/flp/merge/pick"');
    const r = await post(app, "/p/@alice/flp/merge/take", alice, { from: "try" });
    expect(r.statusCode).toBe(303);
    expect(await head("flp", "main")).toBe(tried);
  });

  it("records a save with two parents when the Main version has moved on", async () => {
    const base = await head("flp", "main");
    await post(app, "/p/@alice/flp/branches", alice, { name: "later", commit: base });
    const idea = await save("flp", "later", "a.flp", flp("idea"));
    await save("flp", "main", "a.flp", flp("main moved"));
    const r = await post(app, "/p/@alice/flp/merge/take", alice, { from: "later" });
    const merged = String(r.headers.location).split("/c/")[1]!;
    const row = await db.get<{ parent2_id: string; message: string }>("SELECT parent2_id, message FROM commits WHERE id = ?", [merged]);
    expect(row).toEqual({ parent2_id: idea, message: "Brought in the idea “later”" });
    expect((await get(app, "/p/@alice/flp/graph")).body).toContain("brought together");
  });

  it("keeps both parents when you combine the files yourself", async () => {
    const base = await head("flp", "main");
    await post(app, "/p/@alice/flp/branches", alice, { name: "hands", commit: base });
    const idea = await save("flp", "hands", "a.flp", flp("hands"));
    const form = (await get(app, `/p/@alice/flp/commit?branch=main&merge=${idea}`, alice)).body;
    expect(form).toContain('name="merge"');
    expect(form).toContain("combines the Main version with the idea “hands”");
    const r = await postMultipart(app, "/p/@alice/flp/commit", alice, [{ name: "merge", value: idea }, { name: "branch", value: "main" }, { name: "message", value: "combined by hand" }, { name: "project", filename: "a.flp", data: flp("combined") }]);
    const id = String(r.headers.location).split("/c/")[1]!;
    const row = await db.get<{ parent_id: string; parent2_id: string }>("SELECT parent_id, parent2_id FROM commits WHERE id = ?", [id]);
    expect(row).toEqual({ parent_id: base, parent2_id: idea });
  });

  it("offers picking instruments for Ableton, and saves the result", async () => {
    await save("live", "main", "set.als", fixtureAls());
    await post(app, "/p/@alice/live/branches", alice, { name: "keys", from: "main" });
    await save("live", "keys", "set.als", fixtureAls({ extraTrack: "Keys" }));
    const page = (await get(app, "/p/@alice/live/merge?from=keys", alice)).body;
    expect(page).toContain('action="/p/@alice/live/merge/pick"');
    expect(page).toContain(">Keys<input");
    const names: [string, string][] = [...page.matchAll(/name="(name\d+)" value="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]);
    const fields: Record<string, string> = { from: "keys", count: String(names.length) };
    for (const [field, name] of names) fields[field.replace("name", "pick")] = name === "Vocals" ? "none" : name === "Keys" ? "idea" : "main";
    for (const [field, name] of names) fields[field] = name;
    const r = await post(app, "/p/@alice/live/merge/pick", alice, fields);
    expect(r.statusCode).toBe(303);
    const saved = (await get(app, String(r.headers.location))).body;
    expect(saved).toContain(">Keys</a>");
    expect(saved).not.toContain(">Vocals</a>");
  });
});
