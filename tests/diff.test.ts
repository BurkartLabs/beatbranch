import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { diffFiles, diffModels } from "../src/diff/diff.js";
import { parseAls } from "../src/parsers/als.js";
import { parseFlp } from "../src/parsers/flp.js";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { get, person, postMultipart, wav, world, type Person } from "./helpers.js";
import { fixtureAls, fixtureFlp, fixtureLogicZip } from "./fixtures.js";

const texts = (d: ReturnType<typeof diffModels>) => d.changes.map((c) => `${c.kind}:${c.what}:${c.text}`);
const alsWith = (edit: (xml: string) => string, o: Parameters<typeof fixtureAls>[0] = {}) => zlib.gzipSync(Buffer.from(edit(zlib.gunzipSync(fixtureAls(o)).toString("utf8"))));

describe("what changed inside a project (AB#3010, 3022, 3031, 3042)", () => {
  it("finds an added instrument, a tempo change, a changed plugin and changed sounds", () => {
    const d = diffModels(parseFlp(fixtureFlp()), parseFlp(fixtureFlp({ extraChannel: "Pad", tempo: 150, bassPlugin: "Vital", kickSample: "C:\\Samples\\kick2.wav" })));
    const t = texts(d);
    expect(t).toContain("tracks:added:New instrument “Pad”");
    expect(t).toContain("tempo:changed:Tempo went from 140 to 150 BPM");
    expect(t).toContain("plugins:added:Bass: added “Vital”");
    expect(t).toContain("plugins:removed:Bass: removed “Serum”");
    expect(t).toContain("samples:added:New sound kick2.wav");
    expect(t).toContain("samples:removed:Removed sound kick.wav");
    expect(d.addedTracks.has("ch2")).toBe(true);
    expect(d.changedTracks.has("ch1")).toBe(true);
    expect(d.changedTracks.has("ch0")).toBe(false);
  });
  it("sees a renamed track as a rename, not an add and a remove", () => {
    const t = texts(diffModels(parseAls(fixtureAls()), parseAls(fixtureAls({ renameBass: "Sub" }))));
    expect(t).toContain("tracks:renamed:“Bass” is now called “Sub”");
    expect(t.some((x) => x.startsWith("tracks:added"))).toBe(false);
  });
  it("reports a key change and a change of where a track sends its sound", () => {
    const after = alsWith((x) => x.replace('<RootNote Value="9"/>', '<RootNote Value="2"/>').replace('<Manual Value="0.5"/>', '<Manual Value="0"/>'));
    const t = texts(diffModels(parseAls(fixtureAls()), parseAls(after)));
    expect(t).toContain("tempo:changed:Key went from A Minor to D Minor");
    expect(t).toContain("mixer:removed:Bass no longer sends to “A-Reverb”");
  });
  it("tells which audio files changed by their content, not their name (AB#3102)", () => {
    const f = (kind: "stem" | "bounce", name: string, hash: string) => ({ kind, name, hash, size: 1, contentType: "audio/wav", position: 0 });
    const d = diffFiles([f("stem", "drums.wav", "a"), f("stem", "bass.wav", "b")], [f("stem", "drums.wav", "a"), f("stem", "bass.wav", "c"), f("stem", "pad.wav", "d")]);
    expect(d.map((x) => `${x.name}:${x.what}`)).toEqual(["bass.wav:changed", "drums.wav:same", "pad.wav:added"]);
  });
});

describe("the What changed page (AB#3056, 3070, 3079, 3120, 3128)", () => {
  let app: FastifyInstance;
  let db: PostgresDb;
  let alice: Person;
  beforeAll(async () => {
    ({ app, db } = await world());
    alice = await person(db, "alice");
    await createProject(db, alice.id, { name: "Song", visibility: "public", daw: "fl-studio" });
    await createProject(db, alice.id, { name: "Logic", visibility: "public", daw: "logic" });
  });
  afterAll(async () => {
    await app.close();
  });

  it("groups the changes, highlights changed instruments, shows changed audio side by side and plays A/B", async () => {
    await postMultipart(app, "/p/@alice/song/commit", alice, [{ name: "message", value: "one" }, { name: "project", filename: "s.flp", data: fixtureFlp() }, { name: "stems", filename: "drums.wav", data: wav("d") }, { name: "stems", filename: "bass.wav", data: wav("b") }, { name: "bounce", filename: "mix.wav", data: wav("m1") }]);
    await postMultipart(app, "/p/@alice/song/commit", alice, [{ name: "message", value: "two" }, { name: "project", filename: "s.flp", data: fixtureFlp({ extraChannel: "Pad", tempo: 150 }) }, { name: "stems", filename: "drums.wav", data: wav("d") }, { name: "stems", filename: "bass.wav", data: wav("b2", 900) }, { name: "bounce", filename: "mix.wav", data: wav("m2", 900) }]);
    const page = (await get(app, "/p/@alice/song/compare")).body;
    expect(page).toContain("<h3>Instruments</h3>");
    expect(page).toContain("<h3>Tempo and key</h3>");
    expect(page).toContain("Tempo went from 140 to 150 BPM");
    expect(page).toContain('class="lane lane-added"');
    expect(page).toContain("Changed audio, side by side");
    expect((page.match(/<figure class="mini-wave">/g) ?? []).length).toBe(4);
    expect(page).toContain('data-mode="ab"');
    expect(page).toContain(">A: before</button>");
    expect(page).toMatch(/badge-same">Same<\/span><span class="file-name">drums.wav/);
    expect(page).toMatch(/badge-changed">Changed<\/span><span class="file-name">bass.wav/);
  });

  it("says plainly when the project can't be compared inside", async () => {
    await postMultipart(app, "/p/@alice/logic/commit", alice, [{ name: "message", value: "a" }, { name: "project", filename: "m.zip", data: fixtureLogicZip() }]);
    await postMultipart(app, "/p/@alice/logic/commit", alice, [{ name: "message", value: "b" }, { name: "project", filename: "m.zip", data: fixtureLogicZip() }, { name: "bounce", filename: "x.wav", data: wav("x") }]);
    const page = (await get(app, "/p/@alice/logic/compare")).body;
    expect(page).toContain("A detailed comparison isn't available for this kind of project");
    expect(page).toContain("badge-added");
  });
});
