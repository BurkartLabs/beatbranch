import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, postMultipart, wav, world, type Person } from "./helpers.js";

let app: FastifyInstance;
let db: PostgresDb;
let dataDir: string;
let alice: Person;
let bob: Person;
const url = "/p/@alice/night-drive";

beforeAll(async () => {
  ({ app, db, dataDir } = await world({ STORAGE_QUOTA_BYTES: "20000" }));
  alice = await person(db, "alice");
  bob = await person(db, "bob");
  await createProject(db, alice.id, { name: "Night Drive", visibility: "public", daw: "fl-studio" });
});
afterAll(async () => {
  await app.close();
});

const blobCount = () => {
  const root = path.join(dataDir, "blobs");
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const a of fs.readdirSync(root)) for (const b of fs.readdirSync(path.join(root, a))) n += fs.readdirSync(path.join(root, a, b)).length;
  return n;
};

describe("commit upload (AB#2805, AB#2817, AB#2834)", () => {
  it("stores a commit with a project file, stems and a bounce, and moves main", async () => {
    const r = await postMultipart(app, `${url}/commit`, alice, [
      { name: "branch", value: "main" },
      { name: "message", value: "v1 - first idea" },
      { name: "project", filename: "night.flp", data: flp("one") },
      { name: "stems", filename: "bass.wav", data: wav("bass") },
      { name: "stems", filename: "drums.wav", data: wav("drums") },
      { name: "bounce", filename: "mix.wav", data: wav("mix") }
    ]);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toMatch(/\/c\/[0-9a-f-]{36}$/);
    const files = await db.all<{ kind: string; name: string }>("SELECT kind, name FROM commit_files ORDER BY position");
    expect(files.map((f) => `${f.kind}:${f.name}`)).toEqual(["project:night.flp", "stem:bass.wav", "stem:drums.wav", "bounce:mix.wav"]);
    expect(blobCount()).toBe(4);
    const page = await get(app, String(r.headers.location), alice);
    expect(page.body).toContain("v1 - first idea");
    expect(page.body).toContain("drums.wav");
    const project = await get(app, url);
    expect(project.body).toContain("v1 - first idea");
  });

  it("stores an unchanged file once across commits: one blob, two references (AB#2817)", async () => {
    const r = await postMultipart(app, `${url}/commit`, alice, [
      { name: "message", value: "v2 - new hats" },
      { name: "project", filename: "night.flp", data: flp("two") },
      { name: "stems", filename: "bass.wav", data: wav("bass") }
    ]);
    expect(r.statusCode).toBe(303);
    expect(blobCount()).toBe(5);
    const refs = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM commit_files WHERE name = 'bass.wav'");
    expect(refs?.n).toBe(2);
    const blobs = await db.get<{ n: number }>("SELECT COUNT(DISTINCT blob_hash) AS n FROM commit_files WHERE name = 'bass.wav'");
    expect(blobs?.n).toBe(1);
    const list = (await get(app, url)).body;
    expect(list.indexOf("v2 - new hats")).toBeLessThan(list.indexOf("v1 - first idea"));
  });

  it("refuses an upload past the quota before storing anything (AB#2834)", async () => {
    const before = blobCount();
    const r = await postMultipart(app, `${url}/commit`, alice, [
      { name: "message", value: "too big" },
      { name: "project", filename: "night.flp", data: flp("three") },
      { name: "bounce", filename: "long.wav", data: wav("long", 12000) }
    ]);
    expect(r.statusCode).toBe(413);
    expect(r.body).toContain("Nothing was stored");
    expect(blobCount()).toBe(before);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM commits")).toEqual({ n: 2 });
  });

  it("refuses a file that is not what its name says, a missing message, and a missing project file", async () => {
    const fake = await postMultipart(app, `${url}/commit`, alice, [{ name: "message", value: "x" }, { name: "project", filename: "night.flp", data: Buffer.from("MZ not a project") }]);
    expect(fake.statusCode).toBe(400);
    expect(fake.body).toContain("not a real .flp");
    const wrongKind = await postMultipart(app, `${url}/commit`, alice, [{ name: "message", value: "x" }, { name: "project", filename: "night.als", data: Buffer.from([0x1f, 0x8b, 8, 0]) }]);
    expect(wrongKind.statusCode).toBe(400);
    const noMessage = await postMultipart(app, `${url}/commit`, alice, [{ name: "message", value: "  " }, { name: "project", filename: "n.flp", data: flp("m") }]);
    expect(noMessage.statusCode).toBe(400);
    expect(noMessage.body).toContain("Say what you changed");
    const noProject = await postMultipart(app, `${url}/commit`, alice, [{ name: "message", value: "stems only" }, { name: "stems", filename: "a.wav", data: wav("a") }]);
    expect(noProject.statusCode).toBe(400);
  });

  it("refuses a multipart form whose first part is not the CSRF token, and a non-member", async () => {
    const r = await postMultipart(app, `${url}/commit`, alice, [{ name: "message", value: "x" }, { name: "project", filename: "n.flp", data: flp("c") }], false);
    expect(r.statusCode).toBe(403);
    const stranger = await postMultipart(app, `${url}/commit`, bob, [{ name: "message", value: "x" }, { name: "project", filename: "n.flp", data: flp("d") }]);
    expect(stranger.statusCode).toBe(403);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM commits")).toEqual({ n: 2 });
  });
});

describe("downloads through short-lived, per-user URLs (AB#2845, AB#3770)", () => {
  it("redirects to a signed URL that works for its user, not for another, and not once expired", async () => {
    const commit = await db.get<{ id: string }>("SELECT id FROM commits ORDER BY created_at LIMIT 1");
    const r = await get(app, `${url}/c/${commit!.id}/f/1`, alice);
    expect(r.statusCode).toBe(303);
    const signed = String(r.headers.location);
    expect(signed).toMatch(/^\/blob\/[0-9a-f]{64}\?/);
    const ok = await get(app, signed, alice);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-disposition"]).toContain("attachment");
    expect(ok.headers["content-type"]).toBe("application/octet-stream");
    expect(ok.rawPayload.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect((await get(app, signed, bob)).statusCode).toBe(403);
    expect((await get(app, signed)).statusCode).toBe(403);
    const tampered = signed.replace(/exp=\d+/, "exp=9999999999");
    expect((await get(app, tampered, alice)).statusCode).toBe(403);
    const expired = new URL(signed, "http://x");
    const past = String(Math.floor(Date.now() / 1000) - 10);
    expired.searchParams.set("exp", past);
    expect((await get(app, `${expired.pathname}${expired.search}`, alice)).statusCode).toBe(403);
  });
});
