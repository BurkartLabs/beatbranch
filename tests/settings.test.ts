import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, post, postMultipart, wav, world, type Person } from "./helpers.js";

let app: FastifyInstance;
let db: PostgresDb;
let dataDir: string;
let alice: Person;
let bob: Person;

const blobFiles = () => {
  const root = path.join(dataDir, "blobs");
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const a of fs.readdirSync(root)) for (const b of fs.readdirSync(path.join(root, a))) n += fs.readdirSync(path.join(root, a, b)).length;
  return n;
};

beforeAll(async () => {
  ({ app, db, dataDir } = await world());
  alice = await person(db, "alice");
  bob = await person(db, "bob");
  await createProject(db, alice.id, { name: "Open", visibility: "public", daw: "fl-studio" });
  await createProject(db, alice.id, { name: "Other", visibility: "public", daw: "fl-studio" });
});
afterAll(async () => {
  await app.close();
});

describe("song details (AB#2758, AB#2780, AB#3782)", () => {
  it("changes state and tags, shown on the page", async () => {
    const r = await post(app, "/p/@alice/open/settings", alice, { name: "Open", state: "mixing", tags: "dark, 808", bpm: "140" });
    expect(r.statusCode).toBe(303);
    const page = await get(app, "/p/@alice/open");
    expect(page.body).toContain("Mixing");
    expect(page.body).toContain("140 BPM");
    expect(page.body).toContain(">dark<");
    const again = await post(app, "/p/@alice/open/settings", alice, { name: "Open", state: "mastering", tags: "dark" });
    expect(again.statusCode).toBe(303);
    expect((await get(app, "/p/@alice/open")).body).not.toContain(">808<");
  });

  it("making a song private hides it and its files at once, on every page", async () => {
    const saved = await postMultipart(app, "/p/@alice/open/commit", alice, [{ name: "message", value: "v1" }, { name: "project", filename: "o.flp", data: flp("o") }, { name: "bounce", filename: "m.wav", data: wav("m") }]);
    const commitUrl = String(saved.headers.location);
    expect((await get(app, commitUrl, bob)).statusCode).toBe(200);
    const file = await get(app, `${commitUrl}/f/1`, bob);
    expect(file.statusCode).toBe(303);
    await post(app, "/p/@alice/open/settings", alice, { name: "Open", state: "mastering", visibility: "private" });
    for (const u of ["/p/@alice/open", commitUrl, `${commitUrl}/f/1`, "/p/@alice/open/branches", "/p/@alice/open/graph"]) expect((await get(app, u, bob)).statusCode).toBe(404);
    expect((await get(app, "/explore")).body).not.toContain("/p/@alice/open");
    expect((await get(app, commitUrl, alice)).statusCode).toBe(200);
  });

  it("only the owner changes who can see it; a stranger can't open the settings", async () => {
    expect((await get(app, "/p/@alice/other/settings", bob)).statusCode).toBe(403);
    expect((await post(app, "/p/@alice/other/settings", bob, { name: "Hacked", state: "idea" })).statusCode).toBe(403);
  });
});

describe("deleting (AB#3786)", () => {
  it("deleting a song removes the files no other save uses, and keeps the ones another song still uses", async () => {
    await postMultipart(app, "/p/@alice/other/commit", alice, [{ name: "message", value: "shares a bounce" }, { name: "project", filename: "x.flp", data: flp("x") }, { name: "bounce", filename: "m.wav", data: wav("m") }]);
    const before = blobFiles();
    expect(before).toBe(3);
    const wrong = await post(app, "/p/@alice/open/delete", alice, { confirm: "nope" });
    expect(wrong.statusCode).toBe(400);
    const r = await post(app, "/p/@alice/open/delete", alice, { confirm: "Open" });
    expect(r.statusCode).toBe(303);
    expect(blobFiles()).toBe(2);
    expect(await db.get("SELECT 1 AS x FROM projects WHERE slug = 'open'")).toBeUndefined();
  });

  it("deleting an account needs the password and removes everything only it held", async () => {
    expect((await post(app, "/settings/delete", alice, { password: "wrong password here" })).statusCode).toBe(403);
    const r = await post(app, "/settings/delete", alice, { password: "twelve letters at least" });
    expect(r.statusCode).toBe(303);
    expect(blobFiles()).toBe(0);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")).toEqual({ n: 0 });
    expect((await get(app, "/@alice")).statusCode).toBe(404);
  });
});

describe("profile (AB#2736)", () => {
  it("edits name and bio, and changes the handle once a month", async () => {
    await createProject(db, bob.id, { name: "Bob Song", visibility: "public", daw: "ableton" });
    await createProject(db, bob.id, { name: "Hidden", visibility: "private", daw: "ableton" });
    const r = await post(app, "/settings", bob, { displayName: "Bobby", bio: "I make beats.", handle: "bobby" });
    expect(r.statusCode).toBe(303);
    const page = await get(app, "/@bobby");
    expect(page.body).toContain("Bobby");
    expect(page.body).toContain("I make beats.");
    expect(page.body).toContain("/p/@bobby/bob-song");
    expect(page.body).not.toContain("hidden");
    const again = await post(app, "/settings", bob, { displayName: "Bobby", bio: "", handle: "robert" });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain("You can change it again on");
    expect((await post(app, "/settings", bob, { displayName: "Bobby", bio: "", handle: "admin" })).statusCode).toBe(409);
  });
});
