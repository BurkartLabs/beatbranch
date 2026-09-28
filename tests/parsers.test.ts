import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlp } from "../src/parsers/flp.js";
import { Model } from "../src/parsers/model.js";
import { parseProject } from "../src/parsers/parse.js";
import { parseInSandbox, runSandboxed } from "../src/parsers/run.js";
import { listZip, ZipRefused } from "../src/parsers/zip.js";
import { fixtureAls, fixtureBitwig, fixtureFlp, fixtureLogicZip, fixtureRpp, fixtureSong, zip, zipBomb } from "./fixtures.js";
import { tempDir } from "./temp-dir.js";

const ok = (r: ReturnType<typeof parseProject>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.model;
};

describe("FL Studio (AB#3448, 3458, 3470, 3482, 3490, 3504)", () => {
  const m = parseFlp(fixtureFlp(), new Set(["kick.wav"]));
  it("reads every channel as a track, with its plugin and its mixer insert's plugins", () => {
    expect(m.tracks.map((t) => t.name)).toEqual(["Kick", "Bass"]);
    expect(m.tracks[1]!.plugins).toEqual(["Serum", "Fruity Compressor", "Soundgoodizer"]);
    expect(m.tracks[0]!.plugins).toEqual(["Fruity Parametric EQ 2"]);
  });
  it("places pattern blocks on the timeline at their start and length", () => {
    expect(m.tracks[1]!.clips.map((c) => [c.name, c.start, c.length])).toEqual([["Intro", 0, 4], ["Drop", 4, 8], ["Drop", 12, 4]]);
    expect(m.tracks[0]!.clips.map((c) => [c.name, c.start])).toEqual([["Drop", 4], ["Drop", 12]]);
    expect(m.lengthBeats).toBe(16);
  });
  it("captures mixer names and where each insert sends", () => {
    expect(m.mixer.map((x) => x.name)).toEqual(["Master", "Kick Bus", "Bass Bus", "Reverb"]);
    expect(m.mixer[2]!.sends).toEqual([3]);
    expect(m.tracks[1]!.sends).toEqual(["Reverb"]);
  });
  it("reads tempo, time signature, samples bundled or missing, and notes", () => {
    expect(m.tempo).toBe(140);
    expect(m.timeSignature).toEqual([4, 4]);
    expect(m.samples).toEqual([{ path: "C:\\Samples\\kick.wav", name: "kick.wav", bundled: true }]);
    expect(parseFlp(fixtureFlp()).samples[0]!.bundled).toBe(false);
    const drop = m.patterns.find((p) => p.name === "Drop")!;
    expect(drop.notes.filter((n) => n.key === 41)).toEqual([{ start: 0, length: 2, key: 41, velocity: 110 / 128, track: "ch1" }]);
    expect(drop.notes.map((n) => n.key)).toEqual([36, 36, 41, 44]);
  });
  it("validates against the shared model", () => {
    expect(Model.safeParse(m).success).toBe(true);
  });
  it("refuses a corrupt file rather than guessing", () => {
    const bad = fixtureFlp();
    bad.writeUInt32LE(99999999, 18);
    const cut = Buffer.concat([bad.subarray(0, 60), Buffer.from([0xe0, 0xff, 0xff, 0xff, 0x0f])]);
    expect(parseProject({ daw: "fl-studio", name: "x.flp", project: cut, samples: null }).ok).toBe(false);
    expect(parseProject({ daw: "fl-studio", name: "x.flp", project: Buffer.from("MZ executable"), samples: null }).ok).toBe(false);
  });
  it("reads a project from inside FL's zipped loop package, samples marked bundled", () => {
    const pkg = zip([{ name: "Song/Song.flp", data: fixtureFlp() }, { name: "Song/Samples/kick.wav", data: Buffer.from("RIFFxxxxWAVE") }]);
    const r = ok(parseProject({ daw: "fl-studio", name: "song.zip", project: pkg, samples: null }));
    expect(r.samples[0]!.bundled).toBe(true);
  });
});

describe("Ableton (AB#3529, 3540)", () => {
  const m = ok(parseProject({ daw: "ableton", name: "set.als", project: fixtureAls(), samples: null }));
  it("reads tracks, tempo, key, devices, sends and clips", () => {
    expect(m.tracks.map((t) => t.name)).toEqual(["Bass", "Vocals", "A-Reverb"]);
    expect(m.tempo).toBe(124);
    expect(m.key).toBe("A Minor");
    expect(m.tracks[0]!.plugins).toEqual(["Serum", "Compressor2"]);
    expect(m.tracks[0]!.sends).toEqual(["A-Reverb"]);
    expect(m.tracks[1]!.clips[0]).toMatchObject({ start: 16, length: 16, kind: "audio", sample: "C:/Samples/vocal.wav" });
  });
  it("reads a MIDI clip's notes for the piano roll", () => {
    const p = m.patterns[0]!;
    expect(p.notes.map((n) => [n.key, n.start, n.length])).toEqual([[36, 0, 1], [43, 1, 1], [36, 2, 0.5]]);
  });
});

describe("Reaper, Studio One, Bitwig, Logic (AB#3553, 3558, 3576)", () => {
  it("reads Reaper tracks, items in beats, tempo and effects", () => {
    const m = ok(parseProject({ daw: "reaper", name: "p.rpp", project: fixtureRpp(), samples: null }));
    expect(m.tempo).toBe(95);
    expect(m.timeSignature).toEqual([3, 4]);
    expect(m.tracks.map((t) => t.name)).toEqual(["Drums", "Keys"]);
    expect(m.tracks[1]!.plugins).toEqual(["Keyscape"]);
    expect(m.tracks[0]!.clips[0]!.length).toBeCloseTo(8, 2);
    expect(m.tracks[1]!.clips[0]!.start).toBeCloseTo(4, 2);
    expect(m.tracks[0]!.sends).toEqual(["Keys"]);
  });
  it("reads Studio One tracks and tempo", () => {
    const m = ok(parseProject({ daw: "studio-one", name: "s.song", project: fixtureSong(), samples: null }));
    expect(m.tracks.map((t) => [t.name, t.kind])).toEqual([["Lead", "audio"], ["Pads", "midi"]]);
    expect(m.tempo).toBe(128);
    expect(m.tracks[0]!.plugins).toEqual(["Pro EQ"]);
  });
  it("says plainly that Bitwig and Logic are details only, and invents no tracks", () => {
    const b = ok(parseProject({ daw: "bitwig", name: "p.bwproject", project: fixtureBitwig(), samples: null }));
    expect(b.metadataOnly).toBe(true);
    expect(b.tracks).toEqual([]);
    const l = ok(parseProject({ daw: "logic", name: "m.zip", project: fixtureLogicZip(), samples: null }));
    expect(l.metadataOnly).toBe(true);
    expect(l.tracks).toEqual([]);
    expect(l.tempo).toBe(92);
    expect(l.key).toBe("D minor");
    expect(l.notes.join(" ")).toContain("private format");
  });
});

describe("the sandbox (AB#2859, AB#3830)", () => {
  it("refuses a zip entry that climbs out of its folder", () => {
    expect(() => listZip(zip([{ name: "../../etc/passwd", data: Buffer.from("x") }]))).toThrow(ZipRefused);
    expect(parseProject({ daw: "other", name: "a.zip", project: zip([{ name: "..\\evil.flp", data: fixtureFlp() }]), samples: null }).ok).toBe(false);
  });
  it("refuses a zip bomb without unpacking it", () => {
    const r = parseProject({ daw: "studio-one", name: "bomb.song", project: zipBomb(), samples: null });
    expect(r.ok).toBe(false);
  });
  it("parses in a separate worker, and a project that eats memory is stopped without harming the server", async () => {
    const dir = tempDir("bb-sandbox-");
    const file = path.join(dir, "s.flp");
    fs.writeFileSync(file, fixtureFlp());
    const good = await parseInSandbox({ daw: "fl-studio", name: "s.flp", project: file, samples: null });
    expect(good.ok).toBe(true);
    const hog = await runSandboxed<{ ok: boolean }>("hog", null, { memoryMb: 32, seconds: 10 });
    expect(hog.ok).toBe(false);
    const slow = await runSandboxed<{ ok: boolean }>("hog", { spin: true }, { memoryMb: 64, seconds: 1 });
    expect(slow).toEqual({ ok: false, reason: "Reading the project took too long, so it was stopped." });
  });
});
