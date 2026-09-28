import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, post, postMultipart, wav, world, type Person } from "./helpers.js";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;
let bob: Person;
let carol: Person;
let commitUrl: string;

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  bob = await person(db, "bob");
  carol = await person(db, "carol");
  await createProject(db, alice.id, { name: "Secret", visibility: "private", daw: "fl-studio", genre: "House" });
  await createProject(db, alice.id, { name: "Open", visibility: "public", daw: "fl-studio", genre: "Techno" });
  const r = await postMultipart(app, "/p/@alice/secret/commit", alice, [{ name: "message", value: "first" }, { name: "project", filename: "s.flp", data: flp("s") }, { name: "bounce", filename: "mix.wav", data: wav("mix") }]);
  commitUrl = String(r.headers.location);
});
afterAll(async () => {
  await app.close();
});

const inviteLink = async (role: string) => {
  const r = await post(app, "/p/@alice/secret/invites", alice, { role });
  expect(r.statusCode).toBe(200);
  return /\/join\/([A-Za-z0-9_-]+)/.exec(r.body)![0]!;
};

describe("approval before uploading (AB#3748)", () => {
  it("won't let an unapproved account upload, until an admin approves it", async () => {
    await createProject(db, carol.id, { name: "Mine", visibility: "public", daw: "ableton" });
    const r = await postMultipart(app, "/p/@carol/mine/commit", carol, [{ name: "message", value: "x" }, { name: "project", filename: "a.als", data: Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]) }]);
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain("waiting to be approved");
    const admin = await get(app, "/admin/reports", alice);
    expect(admin.body).toContain("@carol");
    expect((await get(app, "/admin/reports", bob)).statusCode).toBe(404);
    const approve = await post(app, `/admin/users/${carol.id}/approve`, alice, {});
    expect(approve.statusCode).toBe(303);
    expect(await db.get("SELECT 1 AS x FROM users WHERE id = ? AND verified_at IS NOT NULL", [carol.id])).toBeDefined();
  });
});

describe("invites and roles (AB#3707)", () => {
  it("a listener can hear a private song but can't save to it", async () => {
    expect((await get(app, commitUrl, bob)).statusCode).toBe(404);
    const link = await inviteLink("listener");
    expect((await post(app, link, bob, {})).statusCode).toBe(303);
    expect((await get(app, commitUrl, bob)).statusCode).toBe(200);
    const r = await postMultipart(app, "/p/@alice/secret/commit", bob, [{ name: "message", value: "x" }, { name: "project", filename: "b.flp", data: flp("b") }]);
    expect(r.statusCode).toBe(403);
    expect((await post(app, link, bob, {})).statusCode).toBe(404);
  });

  it("a collaborator invite lets them save new versions, and joining approves them", async () => {
    const link = await inviteLink("collaborator");
    await post(app, link, bob, {});
    const r = await postMultipart(app, "/p/@alice/secret/commit", bob, [{ name: "message", value: "bob's version" }, { name: "project", filename: "b.flp", data: flp("bob") }]);
    expect(r.statusCode).toBe(303);
    const people = await get(app, "/p/@alice/secret/people", alice);
    expect(people.body).toContain("Can save new versions");
  });
});

describe("comments and activity (AB#3714, 3721, 3729)", () => {
  it("members comment on a save, with a time in the song that becomes a marker", async () => {
    expect((await post(app, `${commitUrl}/comments`, bob, { body: "love the drop", timed: "1", at: "1:05" })).statusCode).toBe(303);
    expect((await post(app, `${commitUrl}/comments`, carol, { body: "sneaky" })).statusCode).toBe(404);
    const page = (await get(app, commitUrl, alice)).body;
    expect(page).toContain("love the drop");
    expect(page).toContain('class="marker" data-at="65000"');
    expect((await post(app, `${commitUrl}/comments`, bob, { body: "x", timed: "1", at: "soon" })).statusCode).toBe(400);
  });

  it("shows new saves and comments on your songs in your activity feed", async () => {
    const feed = (await get(app, "/activity", alice)).body;
    expect(feed).toContain("bob&#39;s version");
    expect(feed).toContain("love the drop");
    expect((await get(app, "/activity", carol)).body).not.toContain("bob&#39;s version");
  });
});

describe("explore, reports, own copies and releases (AB#3739, 3748, 3246, 3263, 3409, 3420)", () => {
  it("filters Explore by genre and by open for remix", async () => {
    expect((await get(app, "/explore?genre=Techno")).body).toContain("/p/@alice/open");
    expect((await get(app, "/explore?genre=House")).body).not.toContain("/p/@alice/open");
    expect((await get(app, "/explore?remix=1")).body).not.toContain("/p/@alice/open");
    await post(app, "/p/@alice/open/remix", alice, { open: "1" });
    expect((await get(app, "/explore?remix=1")).body).toContain("/p/@alice/open");
    expect((await post(app, "/p/@alice/open/remix", bob, { open: "0" })).statusCode).toBe(403);
  });

  it("has a report button on a public song that records the report", async () => {
    const page = (await get(app, "/p/@alice/open", bob)).body;
    expect(page).toContain("Report this song");
    expect((await post(app, "/p/@alice/open/report", bob, { reason: "stolen beat" })).statusCode).toBe(200);
    expect((await get(app, "/admin/reports", alice)).body).toContain("stolen beat");
  });

  it("makes your own copy of a public song, credited both ways", async () => {
    await postMultipart(app, "/p/@alice/open/commit", alice, [{ name: "message", value: "v1" }, { name: "project", filename: "o.flp", data: flp("o") }, { name: "bounce", filename: "o.wav", data: wav("o") }]);
    const r = await post(app, "/p/@alice/open/fork", bob, {});
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/p/@bob/open");
    const copy = (await get(app, "/p/@bob/open")).body;
    expect(copy).toContain('a copy of <a href="/p/@alice/open">Open</a>');
    expect(copy).toContain(">v1<");
    expect((await get(app, "/p/@alice/open")).body).toContain('href="/p/@bob/open"');
    expect((await post(app, "/p/@alice/secret/fork", bob, {})).statusCode).toBe(403);
  });

  it("releases a save with a full song, shows it on the song page and the producer page", async () => {
    const c = await db.get<{ id: string }>("SELECT c.id FROM commits c JOIN projects p ON p.id = c.project_id JOIN users u ON u.id = p.owner_id WHERE u.handle = 'alice' AND p.slug = 'open'");
    expect((await post(app, `/p/@alice/open/c/${c!.id}/release`, alice, { name: "Final" })).statusCode).toBe(303);
    expect((await get(app, "/p/@alice/open")).body).toContain("Latest release: Final");
    expect((await get(app, "/@alice")).body).toContain("Open: Final");
    const noBounce = await db.get<{ id: string }>("SELECT c.id FROM commits c WHERE c.message = 'bob''s version'");
    expect((await post(app, `/p/@alice/secret/c/${noBounce!.id}/release`, alice, { name: "x" })).statusCode).toBe(400);
  });
});
