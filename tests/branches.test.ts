import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, post, postMultipart, world, type Person } from "./helpers.js";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;
let bob: Person;
const url = "/p/@alice/song";

async function save(branch: string, message: string) {
  const r = await postMultipart(app, `${url}/commit`, alice, [{ name: "branch", value: branch }, { name: "message", value: message }, { name: "project", filename: "s.flp", data: flp(message) }]);
  expect(r.statusCode).toBe(303);
  return String(r.headers.location).split("/c/")[1]!;
}

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  bob = await person(db, "bob");
  await createProject(db, alice.id, { name: "Song", visibility: "public", daw: "fl-studio" });
});
afterAll(async () => {
  await app.close();
});

describe("ideas (AB#2920, AB#2933, AB#2973, AB#2986)", () => {
  it("starts an idea from any save, and saves made on it stay on it", async () => {
    const first = await save("main", "first");
    await save("main", "second");
    const r = await post(app, `${url}/branches`, alice, { name: "Bass Rework", commit: first });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`${url}?branch=bass-rework`);
    const b = await db.get<{ head_commit_id: string }>("SELECT head_commit_id FROM branches WHERE name = 'bass-rework'");
    expect(b?.head_commit_id).toBe(first);
    await save("bass-rework", "new bass");
    const main = await get(app, `${url}?branch=main`);
    expect(main.body).toContain("second");
    expect(main.body).not.toContain("new bass");
    const idea = await get(app, `${url}?branch=bass-rework`);
    expect(idea.body).toContain("new bass");
    expect(idea.body).toContain("first");
    expect(idea.body).not.toContain(">second<");
    expect(idea.body).toContain("It has 1 save the Main version doesn&#39;t have");
    expect(idea.body).toContain("The Main version has 1 newer save");
  });

  it("switches ideas without reloading the page: the partial answer is only the list", async () => {
    const r = await get(app, `${url}?branch=bass-rework&partial=1`);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("<html");
    expect(r.body).toContain("new bass");
  });

  it("refuses a duplicate name, a save from another project, and a stranger", async () => {
    expect((await post(app, `${url}/branches`, alice, { name: "bass-rework", from: "main" })).statusCode).toBe(400);
    expect((await post(app, `${url}/branches`, alice, { name: "x", commit: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(400);
    expect((await post(app, `${url}/branches`, bob, { name: "sneaky", from: "main" })).statusCode).toBe(403);
  });

  it("lists ideas with how far they are from the Main version, and draws how the song grew", async () => {
    const list = await get(app, `${url}/branches`, alice);
    expect(list.body).toContain("1 save the Main version doesn&#39;t have");
    const graph = await get(app, `${url}/graph`);
    expect(graph.statusCode).toBe(200);
    expect(graph.body).toContain("<svg");
    expect((graph.body.match(/<circle/g) ?? []).length).toBe(3);
  });

  it("won't delete the Main version, or an idea with unsaved work unless you say throw it away", async () => {
    expect((await post(app, `${url}/branches/main/delete`, alice, {})).statusCode).toBe(400);
    const keep = await post(app, `${url}/branches/bass-rework/delete`, alice, {});
    expect(keep.statusCode).toBe(400);
    expect(keep.body).toContain("saves the Main version doesn&#39;t have");
    const gone = await post(app, `${url}/branches/bass-rework/delete`, alice, { abandon: "1" });
    expect(gone.statusCode).toBe(303);
    expect((await get(app, `${url}/branches`, alice)).body).not.toContain("?branch=bass-rework");
    expect((await post(app, `${url}/branches`, alice, { name: "bass-rework", from: "main" })).statusCode).toBe(303);
    expect((await post(app, `${url}/branches/bass-rework/delete`, alice, {})).statusCode).toBe(303);
  });
});
