// The scaffold's own behaviour (AB#3813): it boots on a migrated Postgres, answers /healthz and /version, serves the
// front door, sends the security headers on every response class (T-102), and refuses a cross-site POST.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, SESSION_COOKIE } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createSession, createUser } from "../src/auth/users.js";
import type { PostgresDb } from "../src/db/db.js";
import { testDb } from "./test-db.js";
import { tempDir } from "./temp-dir.js";

let app: FastifyInstance;
let db: PostgresDb;

beforeAll(async () => {
  db = await testDb();
  const config = loadConfig({ DATA_DIR: tempDir("bb-app-"), LOG_LEVEL: "silent" });
  app = await buildApp(config, db);
});
afterAll(async () => {
  await app.close();
});

describe("the scaffold", () => {
  it("answers /healthz", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("serves the front door signed out, with the security headers", async () => {
    const r = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Version control for your beats");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("keeps the headers on a 404 (T-102)", async () => {
    const r = await app.inject({ method: "GET", url: "/nowhere", headers: { accept: "text/html" } });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("refuses a signed-in POST with no Origin, one from another site, and one without the CSRF token", async () => {
    const made = await createUser(db, { email: "a@example.com", password: "correct horse battery", handle: "producer-a", displayName: "Producer A" });
    if (!made.ok) throw new Error(made.reason);
    const { token, session } = await createSession(db, made.user.id);
    const form = { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${token}` };
    const none = await app.inject({ method: "POST", url: "/anything", payload: "a=1", headers: form });
    expect(none.statusCode).toBe(403);
    const other = await app.inject({ method: "POST", url: "/anything", payload: "a=1", headers: { ...form, origin: "https://evil.example" } });
    expect(other.statusCode).toBe(403);
    const noCsrf = await app.inject({ method: "POST", url: "/anything", payload: "a=1", headers: { ...form, origin: "http://127.0.0.1:4420" } });
    expect(noCsrf.statusCode).toBe(403);
    const withCsrf = await app.inject({ method: "POST", url: "/anything", payload: `_csrf=${session.csrfToken}`, headers: { ...form, origin: "http://127.0.0.1:4420" } });
    expect(withCsrf.statusCode).toBe(404); // past both checks: nothing serves /anything
  });

  it("refuses a signed-out POST from nowhere before anything else looks at it", async () => {
    const r = await app.inject({ method: "POST", url: "/anything", payload: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.statusCode).toBe(403);
  });

});
