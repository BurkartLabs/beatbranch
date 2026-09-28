import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { ORIGIN, person, postMultipart, wav, world, type Person } from "./helpers.js";
import { fixtureFlp, zip } from "./fixtures.js";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;
let bob: Person;
let commitId: string;
let signedUrls: string[] = [];
const SECRET = "Private Session 7";

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  bob = await person(db, "bob");
  await db.run("UPDATE users SET verified_at = 1 WHERE id = ?", [bob.id]);
  await createProject(db, alice.id, { name: SECRET, visibility: "private", daw: "fl-studio" });
  const r = await postMultipart(app, "/p/@alice/private-session-7/commit", alice, [
    { name: "message", value: "hidden take" },
    { name: "project", filename: "p.flp", data: fixtureFlp() },
    { name: "stems", filename: "vox.wav", data: wav("vox") },
    { name: "bounce", filename: "mix.wav", data: wav("mix") },
    { name: "samples", filename: "s.zip", data: zip([{ name: "kick.wav", data: wav("k") }]) }
  ]);
  commitId = String(r.headers.location).split("/c/")[1]!;
  for (let pos = 0; pos < 4; pos++) {
    const hop = await app.inject({ method: "GET", url: `/p/@alice/private-session-7/c/${commitId}/f/${pos}`, headers: { cookie: alice.cookie } });
    signedUrls.push(String(hop.headers.location));
  }
});
afterAll(async () => {
  await app.close();
});

function fill(url: string): string {
  return url
    .replace(":handle", "alice")
    .replace(":slug", "private-session-7")
    .replace(":id", commitId)
    .replace(":pos", "0")
    .replace(":name", "main")
    .replace(":who", "alice")
    .replace(":hash", "0".repeat(64));
}

describe("the two-account probe (AB#3765)", () => {
  it("covers every song route there is, and none of them lets a stranger in", async () => {
    const routes = app.registeredRoutes.filter((r) => r.url.startsWith("/p/@:handle/:slug"));
    expect(routes.length).toBeGreaterThanOrEqual(25);
    const leaks: string[] = [];
    for (const r of routes) {
      for (const who of [bob, null]) {
        const res = await app.inject({
          method: r.method as "GET" | "POST",
          url: fill(r.url),
          headers: { accept: "text/html", origin: ORIGIN, ...(who ? { cookie: who.cookie } : {}), ...(r.method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
          ...(r.method === "POST" ? { payload: new URLSearchParams({ _csrf: who?.csrf ?? "", name: "x", body: "x", reason: "x", role: "listener", from: "main", confirm: SECRET }).toString() } : {})
        });
        const allowed = who ? [404, 403, 400] : [404, 403, 303, 401];
        if (!allowed.includes(res.statusCode) || res.body.includes(SECRET) || res.body.includes("hidden take")) leaks.push(`${r.method} ${r.url} as ${who ? "bob" : "nobody"}: ${res.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(await db.get("SELECT 1 AS x FROM projects WHERE name = ?", [SECRET])).toBeDefined();
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM commits")).toEqual({ n: 1 });
  });

  it("the project file, the instrument tracks, the full song and the samples are unreachable by a stranger, even with alice's own links", async () => {
    expect(signedUrls.every((u) => u.startsWith("/blob/"))).toBe(true);
    for (const u of signedUrls) {
      expect((await app.inject({ method: "GET", url: u, headers: { cookie: alice.cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: u, headers: { cookie: bob.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: u })).statusCode).toBe(403);
    }
    const forged = signedUrls[0]!.replace(/sig=[^&]+/, "sig=AAAA");
    expect((await app.inject({ method: "GET", url: forged, headers: { cookie: alice.cookie } })).statusCode).toBe(403);
  });
});
