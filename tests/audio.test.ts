import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createProject } from "../src/projects/repo.js";
import { runSandboxed } from "../src/parsers/run.js";
import { EV, PATTERN_BASE } from "../src/parsers/flp.js";
import type { PostgresDb } from "../src/db/db.js";
import { flp, get, person, postMultipart, wav, world, type Person } from "./helpers.js";
import { FlpWriter, fixtureFlp, playlist, zip } from "./fixtures.js";
import { tempDir } from "./temp-dir.js";
import { Transport } from "../src/web/static/player.mjs";

let app: FastifyInstance;
let db: PostgresDb;
let alice: Person;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

beforeAll(async () => {
  ({ app, db } = await world());
  alice = await person(db, "alice");
  await createProject(db, alice.id, { name: "Beat", visibility: "public", daw: "fl-studio" });
});
afterAll(async () => {
  await app.close();
});

function sampleOnlyFlp(): Buffer {
  const w = new FlpWriter();
  w.text(EV.VERSION, "21.2.3.4004", false).dword(EV.TEMPO_FINE, 120000);
  w.word(EV.CHAN_NEW, 0).byte(EV.CHAN_TYPE, 0).text(EV.PLUGIN_INTERNAL, "Sampler").text(EV.PLUGIN_NAME, "Loop").text(EV.SAMPLE_PATH, "C:\\Samples\\loop.wav");
  w.word(EV.ARR_NEW, 0).data(EV.PLAYLIST, playlist([{ pos: 0, len: 192, ref: 0, track: 0 }, { pos: 192, len: 192, ref: 0, track: 0 }]));
  void PATTERN_BASE;
  return w.build(96);
}

describe("listening (AB#3142, 3662, 3668, 3676, 3682, 3687, 3694)", () => {
  it("makes waveform peaks for every audio file and draws a player with each instrument track", async () => {
    const r = await postMultipart(app, "/p/@alice/beat/commit", alice, [
      { name: "message", value: "with stems" },
      { name: "project", filename: "b.flp", data: fixtureFlp() },
      { name: "stems", filename: "drums.wav", data: wav("drums", 8000) },
      { name: "stems", filename: "bass.wav", data: wav("bass", 8000) }
    ]);
    expect(r.statusCode).toBe(303);
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audio_peaks")).toEqual({ n: 2 });
    const page = (await get(app, String(r.headers.location))).body;
    expect(page).toContain("data-player");
    expect((page.match(/class="stem"/g) ?? []).length).toBe(2);
    expect(page).toContain('class="button quiet mute"');
    expect(page).toContain('class="button quiet solo"');
    expect(page).toContain('class="master"');
    const peaks = JSON.parse(/data-peaks="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"')) as number[];
    expect(peaks.length).toBeGreaterThan(100);
    expect(Math.max(...peaks)).toBeGreaterThan(20);
    expect(page).toContain('type="module" src="/static/player.mjs"');
  });

  it("plays the full song with the same controls when there are no instrument tracks", async () => {
    const r = await postMultipart(app, "/p/@alice/beat/commit", alice, [{ name: "message", value: "bounce only" }, { name: "project", filename: "b.flp", data: flp("x") }, { name: "bounce", filename: "mix.wav", data: wav("mix", 4000) }]);
    const page = (await get(app, String(r.headers.location))).body;
    expect((page.match(/class="stem"/g) ?? []).length).toBe(1);
    expect(page).toContain('class="button primary play"');
    expect(page).toContain('class="master"');
  });

  it("says instrument tracks are needed for a project with synths and nothing to play", async () => {
    const r = await postMultipart(app, "/p/@alice/beat/commit", alice, [{ name: "message", value: "synths only" }, { name: "project", filename: "b.flp", data: fixtureFlp() }]);
    const page = (await get(app, String(r.headers.location))).body;
    expect(page).toContain("uses instruments like synths");
    expect(page).not.toContain("data-player");
  });

  it("mixes a playable preview from the samples of a sample-only project", async () => {
    const r = await postMultipart(app, "/p/@alice/beat/commit", alice, [
      { name: "message", value: "loops" },
      { name: "project", filename: "loops.flp", data: sampleOnlyFlp() },
      { name: "samples", filename: "samples.zip", data: zip([{ name: "Samples/loop.wav", data: wav("loop", 16000) }]) }
    ]);
    const page = (await get(app, String(r.headers.location))).body;
    expect(page).toContain("Preview mix");
    const src = /data-src="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, "&");
    const hop = await get(app, src, alice);
    expect(hop.statusCode).toBe(303);
    const audio = await get(app, String(hop.headers.location), alice);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.rawPayload.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(audio.rawPayload.length).toBe(44 + 44100 * 4 * 2);
  });

  it("decodes in a separate worker, and a broken audio file fails there without harming the server", async () => {
    const dir = tempDir("bb-audio-");
    const bad = path.join(dir, "bad.flac");
    fs.writeFileSync(bad, Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(200, 7)]));
    const r = await runSandboxed<{ ok: boolean }>("../audio/worker", { kind: "peaks", file: bad });
    expect(r.ok).toBe(false);
    if (hasFfmpeg) {
      const src = path.join(dir, "a.wav");
      const mp3 = path.join(dir, "a.mp3");
      fs.writeFileSync(src, wav("tone", 22050));
      spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, mp3]);
      const ok = (await runSandboxed<{ ok: boolean; durationMs: number }>("../audio/worker", { kind: "peaks", file: mp3 })) as { ok: boolean; durationMs: number };
      expect(ok.ok).toBe(true);
      expect(ok.durationMs).toBeGreaterThan(2000);
    }
  });
});

describe("the player's timing (AB#3128, 3668, 3676)", () => {
  it("keeps the playback position when switching between A and B", () => {
    const t = new Transport(2, "ab");
    t.play(10);
    expect(t.position(13.5)).toBe(3.5);
    expect(t.choose(13.5, 1)).toBe(3.5);
    expect(t.gains()).toEqual([0, 1]);
    expect(t.position(15)).toBe(5);
    expect(t.choose(15, 0)).toBe(5);
    expect(t.gains()).toEqual([1, 0]);
  });
  it("mutes one, solos one, and pauses where it was", () => {
    const t = new Transport(3);
    t.toggleMute(1);
    expect(t.gains()).toEqual([1, 0, 1]);
    t.toggleSolo(2);
    expect(t.gains()).toEqual([0, 0, 1]);
    t.play(0);
    expect(t.pause(7)).toBe(7);
    expect(t.position(100)).toBe(7);
    t.seek(100, 42);
    expect(t.position(100)).toBe(42);
  });
});
