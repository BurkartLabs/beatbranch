// Register with email and password (AB#2716): an account can register, the password is hashed, a duplicate email is
// refused with a clear error. And what registration is for: signing in and out, with the sign-in failures counted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, SESSION_COOKIE } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RATE_LIMITS } from "../src/limits/limits.js";
import { safeNext } from "../src/auth/module.js";
import type { PostgresDb } from "../src/db/db.js";
import { testDb } from "./test-db.js";
import { tempDir } from "./temp-dir.js";

let app: FastifyInstance;
let db: PostgresDb;
const ORIGIN = "http://127.0.0.1:4420";
const form = { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN };
const encode = (o: Record<string, string>) => new URLSearchParams(o).toString();

const GOOD = { email: "Alice@Example.com", handle: "alice-beats", displayName: "Alice", password: "twelve letters at least" };

async function register(fields: Record<string, string>, address = "10.0.0.1") {
  return app.inject({ method: "POST", url: "/register", payload: encode(fields), headers: form, remoteAddress: address });
}
async function login(email: string, password: string, address = "10.0.0.2") {
  return app.inject({ method: "POST", url: "/login", payload: encode({ email, password }), headers: form, remoteAddress: address });
}
function cookieOf(r: { cookies: { name: string; value: string; httpOnly?: boolean; sameSite?: string }[] }) {
  return r.cookies.find((c) => c.name === SESSION_COOKIE);
}

beforeAll(async () => {
  db = await testDb();
  app = await buildApp(loadConfig({ DATA_DIR: tempDir("bb-auth-"), LOG_LEVEL: "silent" }), db);
});
afterAll(async () => {
  await app.close();
});

describe("register (AB#2716)", () => {
  it("shows the form signed out", async () => {
    const r = await app.inject({ method: "GET", url: "/register", headers: { accept: "text/html" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("Create your account");
  });

  it("creates the account, hashes the password, signs the browser in, and lands on the front door", async () => {
    const r = await register(GOOD);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/");
    const cookie = cookieOf(r);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe("strict");
    const row = await db.get<{ email: string; handle: string; password_hash: string; role: string }>("SELECT email, handle, password_hash, role FROM users WHERE handle = ?", ["alice-beats"]);
    expect(row?.email).toBe("alice@example.com"); // normalised
    expect(row?.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row?.password_hash).not.toContain(GOOD.password);
    expect(row?.role).toBe("admin"); // the first account reads the reports
    const home = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html", cookie: `${SESSION_COOKIE}=${cookie!.value}` } });
    expect(home.body).toContain("Your projects");
    expect(home.body).toContain("@alice-beats");
  });

  it("refuses a duplicate email with a clear error, and keeps the form filled", async () => {
    const r = await register({ ...GOOD, handle: "someone-else" });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain("An account already uses that email");
    expect(r.body).toContain('value="someone-else"');
    expect(cookieOf(r)).toBeUndefined();
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = ?", ["alice@example.com"])).toEqual({ n: 1 });
  });

  it("refuses a taken or reserved handle, a short password and a bad email, naming the field", async () => {
    const taken = await register({ ...GOOD, email: "b@example.com" });
    expect(taken.statusCode).toBe(409);
    expect(taken.body).toContain("That handle is taken");
    const reserved = await register({ ...GOOD, email: "c@example.com", handle: "admin" });
    expect(reserved.statusCode).toBe(409);
    expect(reserved.body).toContain("not available");
    const weak = await register({ ...GOOD, email: "d@example.com", handle: "dee", password: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.body).toContain("At least 12 characters");
    const badEmail = await register({ ...GOOD, email: "not-an-email", handle: "dee" });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.body).toContain("Enter an email address");
    const second = await db.get<{ role: string }>("SELECT role FROM users WHERE email = ?", ["b@example.com"]);
    expect(second).toBeUndefined();
  });

  it("makes the second account a producer, not an admin", async () => {
    const r = await register({ ...GOOD, email: "bob@example.com", handle: "bob" });
    expect(r.statusCode).toBe(303);
    expect((await db.get<{ role: string }>("SELECT role FROM users WHERE handle = ?", ["bob"]))?.role).toBe("producer");
  });

  it("limits registrations per address", async () => {
    const max = RATE_LIMITS["register-address"].max;
    let last = 0;
    for (let i = 0; i < max + 1; i++) {
      const r = await register({ ...GOOD, email: `many${i}@example.com`, handle: `many-${i}` }, "10.9.9.9");
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("sign in and out", () => {
  it("answers an unknown email and a wrong password with the same words and status", async () => {
    const wrong = await login("alice@example.com", "not the password at all");
    const unknown = await login("nobody@example.com", "not the password at all");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.body).toContain("That email and password do not match");
    expect(unknown.body).toContain("That email and password do not match");
    expect(cookieOf(wrong)).toBeUndefined();
  });

  it("signs in with the right password, honours a safe next, and signs out", async () => {
    const r = await app.inject({ method: "POST", url: "/login", payload: encode({ email: "alice@example.com", password: GOOD.password, next: "/new" }), headers: form });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe("/new");
    const cookie = cookieOf(r)!;
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ method: "GET", url: "/", headers: { accept: "text/html", cookie: `${SESSION_COOKIE}=${cookie.value}` } })).body)?.[1];
    expect(csrf).toBeDefined();
    const out = await app.inject({ method: "POST", url: "/logout", payload: encode({ _csrf: csrf! }), headers: { ...form, cookie: `${SESSION_COOKIE}=${cookie.value}` } });
    expect(out.statusCode).toBe(303);
    const after = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html", cookie: `${SESSION_COOKIE}=${cookie.value}` } });
    expect(after.body).not.toContain("Your projects");
  });

  it("never redirects off the site", () => {
    expect(safeNext("/p/x")).toBe("/p/x");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });

  it("refuses an account after ten failures, from any address, until the window passes", async () => {
    const max = RATE_LIMITS["sign-in-account"].max;
    for (let i = 0; i < max; i++) await login("bob@example.com", "wrong password here", `10.1.1.${i}`);
    const r = await login("bob@example.com", GOOD.password, "10.2.2.2");
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
  });
});
