import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "../src/app.js";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, ORIGIN, person, post, postMultipart, wav, world, type Person } from "./helpers.js";
import { tempDir } from "./temp-dir.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function fakeProviders(users: Record<string, Record<string, unknown>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/token")) {
      const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
      return new Response(JSON.stringify({ access_token: `tok-${code}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const who = users[auth.replace("Bearer tok-", "")];
    return who ? new Response(JSON.stringify(who), { status: 200 }) : new Response("no", { status: 401 });
  }) as typeof fetch;
}

describe("Google and Discord sign-in (AB#2726)", () => {
  let app: FastifyInstance;
  let db: PostgresDb;
  beforeAll(async () => {
    let dataDir: string;
    ({ app, db, dataDir } = await world(
      {},
      {
        fetch: fakeProviders({
          g1: { sub: "google-1", email: "Mia@Example.com", email_verified: true, name: "Mia Beats" },
          g2: { sub: "google-2", email: "nope@example.com", email_verified: false, name: "Nope" },
          d1: { id: "discord-1", email: "mia@example.com", verified: true, username: "mia", global_name: "Mia" },
          d2: { id: "discord-2", email: "new@example.com", verified: true, username: "newbie", global_name: null }
        })
      }
    ));
    fs.writeFileSync(path.join(dataDir, ".env"), ["GOOGLE_CLIENT_ID=g-id", "GOOGLE_CLIENT_SECRET=g-secret", "DISCORD_CLIENT_ID=d-id", "DISCORD_CLIENT_SECRET=d-secret"].join("\n"));
    await person(db, "owner");
  });
  afterAll(async () => {
    await app.close();
  });

  async function signIn(provider: "google" | "discord", code: string) {
    const start = await app.inject({ method: "GET", url: `/auth/${provider}?next=/explore` });
    expect(start.statusCode).toBe(303);
    const to = new URL(String(start.headers.location));
    const state = to.searchParams.get("state")!;
    const cookie = start.cookies.find((c) => c.name === "bb_oauth")!;
    return app.inject({ method: "GET", url: `/auth/${provider}/callback?code=${code}&state=${state}`, headers: { cookie: `bb_oauth=${cookie.value}` } });
  }

  it("shows the buttons, creates an account from a confirmed Google email, and signs in", async () => {
    expect((await get(app, "/login")).body).toContain("Continue with Google");
    const r = await signIn("google", "g1");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('url=/explore"');
    const session = r.cookies.find((c) => c.name === SESSION_COOKIE)!;
    const home = await app.inject({ method: "GET", url: "/", headers: { cookie: `${SESSION_COOKIE}=${session.value}` } });
    expect(home.body).toContain("@mia-beats");
  });

  it("links Discord to the same account by its confirmed email", async () => {
    const r = await signIn("discord", "d1");
    expect(r.statusCode).toBe(200);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'mia@example.com'")).toEqual({ n: 1 });
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM identities")).toEqual({ n: 2 });
  });

  it("refuses an unconfirmed email, a wrong state, and makes a new account for a new Discord user", async () => {
    expect((await signIn("google", "g2")).statusCode).toBe(403);
    const bad = await app.inject({ method: "GET", url: "/auth/google/callback?code=g1&state=forged" });
    expect(bad.statusCode).toBe(400);
    expect((await signIn("discord", "d2")).statusCode).toBe(200);
    expect(await db.get("SELECT handle FROM users WHERE email = 'new@example.com'")).toEqual({ handle: "newbie" });
  });
});

describe("pictures, plans and the version (AB#2881, AB#3921, AB#3903, AB#3838)", () => {
  let app: FastifyInstance;
  let db: PostgresDb;
  let alice: Person;
  let bob: Person;
  beforeAll(async () => {
    ({ app, db } = await world({ STORAGE_QUOTA_BYTES: "3000", STORAGE_QUOTA_PLUS_BYTES: "100000" }));
    alice = await person(db, "alice");
    bob = await person(db, "bob");
    await createProject(db, alice.id, { name: "Pic", visibility: "public", daw: "fl-studio" });
    await db.run("UPDATE users SET verified_at = 1 WHERE id = ?", [bob.id]);
    await createProject(db, bob.id, { name: "Big", visibility: "public", daw: "fl-studio" });
  });
  afterAll(async () => {
    await app.close();
  });

  it.skipIf(!hasFfmpeg)("re-encodes an uploaded picture before showing it, and refuses a program dressed as one", async () => {
    const dir = tempDir("bb-cover-");
    const src = path.join(dir, "a.jpg");
    spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=800x600", "-frames:v", "1", src]);
    const original = fs.readFileSync(src);
    const r = await postMultipart(app, "/p/@alice/pic/cover", alice, [{ name: "cover", filename: "a.jpg", data: original, type: "image/jpeg" }]);
    expect(r.statusCode).toBe(303);
    const img = await get(app, "/p/@alice/pic/cover.png");
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(img.rawPayload.equals(original)).toBe(false);
    expect(img.rawPayload.readUInt32BE(16)).toBe(512);
    expect((await get(app, "/p/@alice/pic")).body).toContain('src="/p/@alice/pic/cover.png"');
    const exe = await postMultipart(app, "/p/@alice/pic/cover", alice, [{ name: "cover", filename: "x.png", data: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]), type: "image/png" }]);
    expect(exe.statusCode).toBe(400);
    expect((await postMultipart(app, "/p/@alice/pic/cover", bob, [{ name: "cover", filename: "a.jpg", data: original }])).statusCode).toBe(403);
  });

  it("gives Free accounts the Free quota and Plus accounts more", async () => {
    const big = () => postMultipart(app, "/p/@bob/big/commit", bob, [{ name: "message", value: "big" }, { name: "project", filename: "b.flp", data: flp("b", 64) }, { name: "bounce", filename: "m.wav", data: wav("m", 3000) }]);
    expect((await big()).statusCode).toBe(413);
    expect((await post(app, `/admin/users/${bob.id}/plan`, alice, { plan: "plus" })).statusCode).toBe(303);
    expect((await big()).statusCode).toBe(303);
    expect((await post(app, `/admin/users/${alice.id}/plan`, bob, { plan: "plus" })).statusCode).toBe(404);
  });

  it("states its version as major.minor.feature.fix, on /version and in the footer", async () => {
    const v = fs.readFileSync(path.join(process.cwd(), "VERSION"), "utf8").trim();
    expect(v).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect((await get(app, "/")).body).toContain(`BeatBranch v${v}`);
  });
});

void ORIGIN;
