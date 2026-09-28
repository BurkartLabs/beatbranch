import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import { renderModel } from "../src/parsers/view.js";
import { emptyModel } from "../src/parsers/model.js";
import type { PostgresDb } from "../src/db/db.js";
import { get, person, postMultipart, world, type Person } from "./helpers.js";
import { fixtureAls, fixtureFlp, fixtureLogicZip, zip } from "./fixtures.js";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  await createProject(db, alice.id, { name: "Flp", visibility: "public", daw: "fl-studio" });
  await createProject(db, alice.id, { name: "Live", visibility: "public", daw: "ableton" });
  await createProject(db, alice.id, { name: "Logic", visibility: "public", daw: "logic" });
});
afterAll(async () => {
  await app.close();
});

const save = async (slug: string, name: string, data: Buffer, extra: { name: string; filename: string; data: Buffer }[] = []) => {
  const r = await postMultipart(app, `/p/@alice/${slug}/commit`, alice, [{ name: "message", value: `save ${name}` }, { name: "project", filename: name, data }, ...extra]);
  expect(r.statusCode).toBe(303);
  return String(r.headers.location);
};

describe("what's inside a save (AB#3603, 3611, 3620, 3630, 3636, 3643)", () => {
  it("shows an FL Studio save's instruments as lanes, with tempo, effects, a piano roll and missing sounds", async () => {
    const url = await save("flp", "song.flp", fixtureFlp(), [{ name: "samples", filename: "samples.zip", data: zip([{ name: "other.wav", data: Buffer.from("RIFFxxxxWAVE") }]) }]);
    const page = (await get(app, url)).body;
    expect(page).toContain("140 BPM");
    expect(page).toContain("4/4");
    expect(page).toContain('class="lane-name" href="#c-track-ch0"');
    expect(page).toContain(">Kick</a>");
    expect(page).toContain(">Bass</a>");
    expect((page.match(/<rect x="[\d.]+" y="3"/g) ?? []).length).toBe(5);
    expect(page).toContain('id="c-pr-1"');
    expect(page).toContain("<li>Fruity Compressor</li>");
    expect(page).toContain("Also sends its sound to: Master, Reverb");
    expect(page).toContain("Missing</span> <span class=\"file-name\">kick.wav");
    expect(page).toContain("1 sound missing");
    const project = (await get(app, "/p/@alice/flp")).body;
    expect(project).toContain("Inside the project");
    expect(project).toContain('href="#b-track-ch1"');
  });

  it("keeps a save whose file can't be read, and says so without showing anything made up", async () => {
    const broken = fixtureFlp().subarray(0, 40);
    const url = await save("flp", "broken.flp", broken);
    const page = (await get(app, url)).body;
    expect(page).toContain("BeatBranch couldn't read this project file");
    expect(page).toContain("It is still saved");
    expect(page).not.toContain("lane-name");
    const row = await db.get<{ parse_status: string }>("SELECT parse_status FROM commits WHERE message = 'save broken.flp'");
    expect(row?.parse_status).toBe("failed");
  });

  it("draws an Ableton set in the same shape as an FL project", async () => {
    const url = await save("live", "set.als", fixtureAls());
    const page = (await get(app, url)).body;
    expect(page).toContain("124 BPM");
    expect(page).toContain("Key: A Minor");
    expect(page).toContain(">Vocals</a>");
    for (const cls of ['class="model"', 'class="lanes"', 'class="lane-name"', 'class="lane-svg"', 'class="target"', "Sounds this project uses"]) {
      expect(page).toContain(cls);
    }
  });

  it("says plainly that Logic shows details only", async () => {
    const url = await save("logic", "midnight.zip", fixtureLogicZip());
    const page = (await get(app, url)).body;
    expect(page).toContain("92 BPM");
    expect(page).toContain("private format");
    expect(page).not.toContain("lane-name");
  });

  it("renders sixty instruments with every lane and no more work per lane than one drawing (AB#3650)", () => {
    const m = emptyModel("flp", "FL Studio 21");
    m.lengthBeats = 512;
    m.tempo = 120;
    for (let i = 0; i < 60; i++) m.tracks.push({ id: `t${i}`, name: `Track ${i}`, kind: "instrument", color: null, plugins: [], mixer: null, sends: [], clips: Array.from({ length: 40 }, (_, k) => ({ start: k * 12, length: 8, name: "p", kind: "pattern" as const, pattern: null, sample: null })) });
    const out = renderModel(m).value;
    expect((out.match(/class="lane-svg"/g) ?? []).length).toBe(60);
    expect((out.match(/<rect /g) ?? []).length).toBe(60 * 40);
    expect(out.length).toBeLessThan(2_000_000);
  });
});
