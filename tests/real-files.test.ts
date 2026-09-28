import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EV, parseFlp, playlistItemSize } from "../src/parsers/flp.js";
import { decodeWav } from "../src/audio/decode.js";
import { OUT_RATE, renderPreview } from "../src/audio/render.js";
import { createProject } from "../src/projects/repo.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, postMultipart, wav, world, type Person } from "./helpers.js";
import { FlpWriter } from "./fixtures.js";
import { tempDir } from "./temp-dir.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function legacyItems(items: { pos: number; len: number; pattern: number }[]): Buffer {
  const b = Buffer.alloc(32 * items.length);
  items.forEach((it, i) => {
    const o = i * 32;
    b.writeUInt32LE(it.pos, o);
    b.writeUInt16LE(0, o + 4);
    b.writeUInt16LE(0x6000, o + 6);
    b.writeUInt32LE(it.len, o + 8);
    b.writeUInt16LE(999 - it.pattern, o + 12);
    b.writeFloatLE(-1, o + 24);
    b.writeFloatLE(-1, o + 28);
  });
  return b;
}

export function fl9(): Buffer {
  const w = new FlpWriter();
  w.text(EV.VERSION, "9.0.0", false).word(EV.TEMPO_COARSE, 160).byte(EV.TIMESIG_NUM, 4).byte(EV.TIMESIG_BEAT, 4);
  w.word(EV.PAT_NEW, 3).data(EV.PAT_NOTES, Buffer.alloc(0));
  w.word(EV.CHAN_NEW, 0).byte(EV.CHAN_TYPE, 0).byte(EV.CHAN_FX, 1).text(EV.SAMPLE_PATH, "C:\\Samples\\clap.wav", false).text(EV.CHAN_NAME_OLD, "Clap", false);
  w.word(EV.PAT_NEW, 1);
  for (const step of [4, 12]) w.word(EV.STEP_OLD, 256 + step * 2);
  w.word(EV.CHAN_NEW, 1).byte(EV.CHAN_TYPE, 2).text(EV.PLUGIN_INTERNAL, "Sytrus", false).byte(EV.CHAN_FX, 2).text(EV.CHAN_NAME_OLD, "Rhodes", false);
  w.word(EV.PAT_NEW, 2).data(EV.PAT_NOTES, (() => {
    const n = Buffer.alloc(24);
    n.writeUInt32LE(0, 0);
    n.writeUInt16LE(1, 6);
    n.writeUInt32LE(96, 8);
    n.writeUInt16LE(60, 12);
    n[21] = 100;
    return n;
  })());
  const items = Array.from({ length: 15 }, (_, i) => ({ pos: i * 384, len: 384, pattern: i % 2 ? 1 : 2 }));
  w.data(EV.PLAYLIST, legacyItems(items));
  for (let i = 0; i < 105; i++) {
    w.data(EV.INSERT_FLAGS, Buffer.alloc(5));
    w.data(EV.INSERT_NAME, Buffer.from([0]));
    const r = Buffer.alloc(105);
    if (i !== 0) for (const t of [0, 100, 101, 102, 103]) r[t] = 1;
    if (i === 2) r[5] = 1;
    w.data(EV.INSERT_ROUTING, r).dword(EV.INSERT_OUTPUT, 0);
  }
  return w.build(96);
}

describe("an FL Studio 9 project (Bug AB#4759)", () => {
  it("picks the playlist item size by where the blocks land, not by which size divides", () => {
    const d = legacyItems(Array.from({ length: 15 }, (_, i) => ({ pos: i * 384, len: 384, pattern: 1 })));
    expect(d.length % 60).toBe(0);
    expect(playlistItemSize(d)).toBe(32);
  });

  it("reads channel names, one-row-per-pattern blocks, step-sequencer hits, and only the routing that isn't the default", () => {
    const m = parseFlp(fl9());
    expect(m.app).toBe("FL Studio 9.0");
    expect(m.tempo).toBe(160);
    expect(m.tracks.map((t) => t.name)).toEqual(["Clap", "Rhodes"]);
    expect(m.tracks[0]!.clips.map((c) => [c.name, c.start])).toEqual([["Pattern 1", 4], ["Pattern 1", 12], ["Pattern 1", 20], ["Pattern 1", 28], ["Pattern 1", 36], ["Pattern 1", 44], ["Pattern 1", 52]]);
    expect(m.tracks[1]!.clips).toHaveLength(8);
    const p1 = m.patterns.find((p) => p.id === "1")!;
    expect(p1.notes.map((n) => [n.start, n.length])).toEqual([[1, 0.25], [3, 0.25]]);
    expect(m.tracks[0]!.sends).toEqual([]);
    expect(m.tracks[1]!.sends).toEqual(["Insert 5"]);
    expect(m.mixer[100]!.name).toBe("Send 1");
  });
});

describe("playing real-world audio (Bug AB#4759)", () => {
  let app: FastifyInstance;
  let db: PostgresDb;
  let alice: Person;
  let dir: string;
  beforeAll(async () => {
    ({ app, db } = await world());
    alice = await person(db, "alice");
    await createProject(db, alice.id, { name: "Old", visibility: "public", daw: "fl-studio" });
    dir = tempDir("bb-real-");
  });
  afterAll(async () => {
    await app.close();
  });

  function vorbisInWav(): Buffer {
    const src = path.join(dir, "t.wav");
    const ogg = path.join(dir, "t.ogg");
    fs.writeFileSync(src, wav("tone", 44100));
    spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-c:a", "libvorbis", ogg]);
    const data = fs.readFileSync(ogg);
    const h = Buffer.alloc(12 + 8 + 16 + 8);
    h.write("RIFF", 0, "latin1");
    h.writeUInt32LE(h.length - 8 + data.length, 4);
    h.write("WAVEfmt ", 8, "latin1");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(0x674f, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(8000, 24);
    h.writeUInt32LE(16000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "latin1");
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  }

  it.skipIf(!hasFfmpeg)("makes a playable copy of Vorbis-in-WAV, gives it a waveform, and leaves out a file nothing can play", async () => {
    const junk = Buffer.from(vorbisInWav());
    junk.writeUInt16LE(0x1234, 20);
    junk.write("XXXX", 44, "latin1");
    const r = await postMultipart(app, "/p/@alice/old/commit", alice, [
      { name: "message", value: "old samples" },
      { name: "project", filename: "o.flp", data: fl9() },
      { name: "stems", filename: "vorbis.wav", data: vorbisInWav() },
      { name: "stems", filename: "pcm.wav", data: wav("pcm", 8000) },
      { name: "stems", filename: "junk.wav", data: junk }
    ]);
    expect(r.statusCode).toBe(303);
    const page = (await get(app, String(r.headers.location), alice)).body;
    expect((page.match(/class="stem"/g) ?? []).length).toBe(2);
    expect(page).toContain("BeatBranch can&#39;t play junk.wav");
    const vorbisSrc = [...page.matchAll(/data-src="([^"]+)" data-peaks="([^"]+)"/g)].map((m) => [m[1]!.replace(/&amp;/g, "&"), JSON.parse(m[2]!.replace(/&quot;/g, '"')) as number[]] as const);
    expect(vorbisSrc.every(([, p]) => p.length > 100)).toBe(true);
    const hop = await get(app, vorbisSrc[0]![0], alice);
    const audio = await get(app, String(hop.headers.location), alice);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.rawPayload.readUInt16LE(20)).toBe(1);
    expect(page).toContain(">Clap</a>");
  });

  it("explains, in plain words, when every instrument track is just a short sound and the song can't be played from the project", async () => {
    const r = await postMultipart(app, "/p/@alice/old/commit", alice, [{ name: "message", value: "one shots" }, { name: "project", filename: "o.flp", data: flp("x") }, { name: "stems", filename: "hat.wav", data: wav("hat", 2000) }]);
    const page = (await get(app, String(r.headers.location), alice)).body;
    expect(page).toContain("only a few seconds long");
    expect(page).toContain("Split mixer tracks");
    expect((await get(app, "/p/@alice/old/commit", alice)).body).toContain("Split mixer tracks");
  });

  it("styles the project view on every page that draws it", async () => {
    const commit = await db.get<{ id: string }>("SELECT id FROM commits LIMIT 1");
    for (const url of [`/p/@alice/old/c/${commit!.id}`, "/p/@alice/old", "/p/@alice/old/compare"]) {
      const body = (await get(app, url, alice)).body;
      if (body.includes('class="lanes"')) expect(body).toContain('href="/static/projects.css"');
    }
    const css = fs.readFileSync(path.join(process.cwd(), "src", "web", "static", "projects.css"), "utf8");
    expect(css).toMatch(/\.lanes \{[^}]*grid-template-columns: minmax\(8rem, 12rem\) minmax\(0, 1fr\)/);
    expect(css).toContain(".target:target");
  });
});

describe("hearing an FL Studio save without exporting anything (Bug AB#4763)", () => {
  const click = () => ({ rate: OUT_RATE, channels: [Float32Array.from({ length: 400 }, (_, i) => (i < 200 ? 0.8 : 0))] });

  it("plays each instrument's own sample on its notes, and a stand-in voice for a synth", () => {
    const m = parseFlp(fl9());
    const r = renderPreview(m, new Map([["clap.wav", click()]]));
    if (!r.ok) throw new Error(r.reason);
    expect(r.standIns).toEqual(["Rhodes"]);
    expect(r.missing).toEqual([]);
    const out = decodeWav(r.wav).channels[0]!;
    const at = (s: number) => Math.floor(s * OUT_RATE);
    const spb = 60 / 160;
    const loud = (a: number, b: number) => out.subarray(at(a), at(b)).reduce((mx, v) => Math.max(mx, Math.abs(v)), 0);
    expect(loud(0, spb)).toBeGreaterThan(0.01);
    expect(loud(1.5, 5 * spb - 0.005)).toBe(0);
    expect(loud(5 * spb, 5 * spb + 0.004)).toBeGreaterThan(0.05);
  });

  it("names a missing sound instead of refusing the whole song", () => {
    const r = renderPreview(parseFlp(fl9()), new Map());
    if (!r.ok) throw new Error(r.reason);
    expect(r.missing).toEqual(["clap.wav"]);
    expect(r.standIns).toEqual(["Rhodes"]);
  });

  it("makes the song the thing you hear when the uploaded audio is only the project's short samples", async () => {
    const { app, db } = await world();
    const bob = await person(db, "bob");
    await createProject(db, bob.id, { name: "Sketch", visibility: "public", daw: "fl-studio" });
    const r = await postMultipart(app, "/p/@bob/sketch/commit", bob, [{ name: "message", value: "just the flp" }, { name: "project", filename: "s.flp", data: fl9() }, { name: "stems", filename: "clap.wav", data: wav("clap", 2000) }]);
    const page = (await get(app, String(r.headers.location), bob)).body;
    expect((page.match(/class="stem"/g) ?? []).length).toBe(1);
    expect(page).toContain("The song");
    expect(page).toContain("Rhodes uses a simple stand-in sound, because only FL Studio can play that instrument");
    expect(page).not.toContain("only a few seconds long");
    await app.close();
  });
});
