#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { EV, PATTERN_BASE } from "../dist/src/parsers/flp.js";

const [baseUrl, tag = "look"] = process.argv.slice(2);
if (!baseUrl) {
  console.error("usage: node scripts/look-all.mjs <baseUrl> [tag]   (npm run dev first; approves the look account in the dev database)");
  process.exit(2);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "docs", "looks");
const work = fs.mkdtempSync(path.join(root, ".embedded-postgres", "look-"));
fs.mkdirSync(out, { recursive: true });

function varlen(n) {
  const o = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return Buffer.from(o);
}
function flpFile({ tempo, pad }) {
  const parts = [];
  const byte = (id, v) => parts.push(Buffer.from([id, v]));
  const word = (id, v) => { const b = Buffer.alloc(3); b[0] = id; b.writeUInt16LE(v, 1); parts.push(b); };
  const dword = (id, v) => { const b = Buffer.alloc(5); b[0] = id; b.writeUInt32LE(v >>> 0, 1); parts.push(b); };
  const data = (id, d) => parts.push(Buffer.from([id]), varlen(d.length), d);
  const text = (id, s, u = true) => data(id, Buffer.from(`${s}\u0000`, u ? "utf16le" : "latin1"));
  const notes = (list) => { const b = Buffer.alloc(24 * list.length); list.forEach((n, i) => { const o = i * 24; b.writeUInt32LE(n[0], o); b.writeUInt16LE(n[4], o + 6); b.writeUInt32LE(n[1], o + 8); b.writeUInt16LE(n[2], o + 12); b[o + 21] = n[3]; }); return b; };
  const playlist = (items) => { const b = Buffer.alloc(60 * items.length); items.forEach((it, i) => { const o = i * 60; b.writeUInt32LE(it[0], o); b.writeUInt16LE(PATTERN_BASE, o + 4); b.writeUInt16LE(it[2], o + 6); b.writeUInt32LE(it[1], o + 8); b.writeUInt16LE(499 - it[3], o + 12); }); return b; };
  text(EV.VERSION, "21.2.3.4004", false); dword(EV.TEMPO_FINE, tempo * 1000); byte(EV.TIMESIG_NUM, 4); byte(EV.TIMESIG_BEAT, 4);
  const chans = [["Kick", "Sampler", "C:\\Samples\\kick.wav", 1], ["Hats", "Sampler", "C:\\Samples\\hat.wav", 1], ["Bass", "Serum", null, 2], ["Chords", "Sylenth1", null, 3]];
  if (pad) chans.push(["Pad", "Vital", null, 4]);
  chans.forEach(([name, plug, sample, fx], i) => { word(EV.CHAN_NEW, i); byte(EV.CHAN_TYPE, sample ? 0 : 2); text(EV.PLUGIN_INTERNAL, plug); text(EV.PLUGIN_NAME, name); if (sample) text(EV.SAMPLE_PATH, sample); byte(EV.CHAN_FX, fx); });
  const drop = [];
  for (let b = 0; b < 16; b++) drop.push([b * 96, 48, 36, 110, 0]);
  for (let b = 0; b < 32; b++) drop.push([b * 48 + 24, 12, 42, 70, 1]);
  [41, 41, 44, 46, 41, 39, 41, 44].forEach((k, i) => drop.push([i * 192, 150, k, 100, 2]));
  [[53, 56, 60], [51, 55, 58], [49, 53, 56], [51, 55, 58]].forEach((ch, i) => ch.forEach((k) => drop.push([i * 384, 360, k, 80, 3])));
  if (pad) [65, 68, 72].forEach((k) => drop.push([0, 1536, k, 60, 4]));
  word(EV.PAT_NEW, 1); text(EV.PAT_NAME, "Drop"); data(EV.PAT_NOTES, notes(drop));
  word(EV.PAT_NEW, 2); text(EV.PAT_NAME, "Intro"); data(EV.PAT_NOTES, notes([[0, 384, 53, 60, 3], [384, 384, 51, 60, 3], [0, 96, 42, 50, 1], [192, 96, 42, 50, 1]]));
  word(EV.ARR_NEW, 0); data(EV.PLAYLIST, playlist([[0, 1536, PATTERN_BASE + 2, 0], [1536, 1536, PATTERN_BASE + 1, 1], [3072, 1536, PATTERN_BASE + 1, 1], [4608, 768, PATTERN_BASE + 2, 0]]));
  const insert = (name, plugs, routes) => { data(EV.INSERT_FLAGS, Buffer.alloc(12)); plugs.forEach((p, i) => { text(EV.PLUGIN_INTERNAL, p); word(EV.SLOT_INDEX, i); }); text(EV.INSERT_NAME, name); const r = Buffer.alloc(8); routes.forEach((x) => (r[x] = 1)); data(EV.INSERT_ROUTING, r); dword(EV.INSERT_OUTPUT, 0); };
  insert("Master", ["Fruity Limiter"], []); insert("Drums", ["Fruity Parametric EQ 2"], [0]); insert("Bass", ["Fruity Compressor", "Soundgoodizer"], [0]); insert("Chords", ["Valhalla Room"], [0]); insert("Pad", ["Fruity Reeverb 2"], [0]);
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(22);
  head.write("FLhd", 0, "latin1"); head.writeUInt32LE(6, 4); head.writeUInt16LE(0, 8); head.writeUInt16LE(chans.length, 10); head.writeUInt16LE(96, 12); head.write("FLdt", 14, "latin1"); head.writeUInt32LE(body.length, 18);
  return Buffer.concat([head, body]);
}
function tone(seconds, fn) {
  const rate = 22050;
  const n = Math.floor(seconds * rate);
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(fn(i / rate) * 20000))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + d.length, 4); h.write("WAVEfmt ", 8, "latin1"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36, "latin1"); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}
const beat = 60 / 124;
const kick = (t) => { const p = (t % beat) / beat; return p < 0.25 ? Math.sin(2 * Math.PI * 55 * t) * (1 - p * 4) : 0; };
const hats = (t) => { const p = ((t + beat / 2) % (beat / 2)) / (beat / 2); return p < 0.1 ? (Math.random() * 2 - 1) * 0.4 * (1 - p * 10) : 0; };
const bass = (f) => (t) => Math.sin(2 * Math.PI * f * t) * 0.6 * (0.6 + 0.4 * Math.sin(t * 2));
const write = (name, buf) => { const p = path.join(work, name); fs.writeFileSync(p, buf); return p; };

const files1 = { project: write("night-drive.flp", flpFile({ tempo: 124 })), stems: [write("Kick.wav", tone(12, kick)), write("Hats.wav", tone(12, hats)), write("Bass.wav", tone(12, bass(55)))], bounce: write("Night Drive.wav", tone(12, (t) => kick(t) * 0.6 + hats(t) * 0.3 + bass(55)(t) * 0.4)) };
const files2 = { project: write("night-drive-2.flp", flpFile({ tempo: 126, pad: true })), stems: [files1.stems[0], files1.stems[1], write("Bass-2.wav", tone(12, bass(49)))], bounce: write("Night Drive 2.wav", tone(12, (t) => kick(t) * 0.6 + hats(t) * 0.3 + bass(49)(t) * 0.5)) };
fs.copyFileSync(files2.stems[2], path.join(work, "Bass.wav.2"));

const handle = `look-${crypto.randomBytes(2).toString("hex")}`;
const browser = await chromium.launch();
const shots = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const go = (u) => page.goto(new URL(u, baseUrl).toString(), { waitUntil: "networkidle" });
  const submit = async (wait) => Promise.all([page.waitForURL(wait, { timeout: 120000 }), page.click("main button[type=submit]")]);
  await go("/register");
  await page.fill("#displayName", "Midnight Cartel");
  await page.fill("#handle", handle);
  await page.fill("#email", `${handle}@example.com`);
  await page.fill("#password", "a long enough look password");
  await submit((u) => u.pathname === "/");
  const password = fs.readFileSync(path.join(root, ".embedded-postgres", "password"), "utf8").trim();
  const db = new pg.Client({ connectionString: `postgres://postgres:${password}@127.0.0.1:${process.env.DEV_PG_PORT ?? 54329}/postgres` });
  await db.connect();
  await db.query("UPDATE users SET verified_at = $1 WHERE handle = $2", [Date.now(), handle]);
  await db.end();
  await go("/new");
  await page.fill("#name", "Night Drive");
  await page.selectOption("#genre", "House");
  await page.selectOption("#subgenre", "Deep house");
  await page.selectOption("#state", "arrangement");
  await page.fill("#bpm", "124");
  await page.fill("#musicalKey", "F minor");
  await page.fill("#description", "Late-night deep house. The bass needs work; the hats are the good part.");
  await page.fill("#tags", "deep house, night, collab");
  await submit(/\/p\/@/);
  const song = new URL(page.url()).pathname;
  const saveTo = async (branch, message, f) => {
    await go(`${song}/commit?branch=${branch}`);
    await page.fill("#message", message);
    await page.setInputFiles("#project", f.project);
    await page.setInputFiles("#stems", f.stems.map((s) => ({ name: path.basename(s).replace("Bass-2", "Bass"), mimeType: "audio/wav", buffer: fs.readFileSync(s) })));
    await page.setInputFiles("#bounce", f.bounce.includes("2") ? { name: "Night Drive.wav", mimeType: "audio/wav", buffer: fs.readFileSync(f.bounce) } : f.bounce);
    await submit(/\/c\//);
    return new URL(page.url()).pathname;
  };
  const first = await saveTo("main", "First sketch: drums, bass and chords", files1);
  await go(first);
  await page.fill("#idea-here", "bass-rework");
  await Promise.all([page.waitForURL(/branch=bass-rework/), page.click("form.start-idea:last-of-type button")]);
  await saveTo("bass-rework", "Lower bass, new pad", files2);
  await saveTo("main", "Brighter hats", { ...files1, project: write("night-drive-3.flp", flpFile({ tempo: 124 })) });
  const shot = async (name, url, opts = {}) => {
    for (const scheme of opts.schemes ?? ["dark", "light"]) {
      for (const size of opts.sizes ?? [{ w: 1280, h: 800 }]) {
        const c = await browser.newContext({ viewport: { width: size.w, height: size.h }, colorScheme: scheme, storageState: await ctx.storageState() });
        const p = await c.newPage();
        const errors = [];
        p.on("pageerror", (e) => errors.push(e.message));
        await p.goto(new URL(url, baseUrl).toString(), { waitUntil: "networkidle" });
        await p.waitForTimeout(300);
        const file = path.join(out, `${tag}-${name}-${size.w}x${size.h}-${scheme}.png`);
        await p.screenshot({ path: file });
        const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        shots.push(`${path.relative(root, file)}${wide > 0 ? ` SIDEWAYS SCROLL ${wide}px` : ""}${errors.length ? ` ERRORS: ${errors.join(" | ")}` : ""}`);
        await c.close();
      }
    }
  };
  await shot("song", song, { sizes: [{ w: 1280, h: 800 }, { w: 375, h: 812 }] });
  await shot("song-idea", `${song}?branch=bass-rework`, { schemes: ["dark"] });
  await shot("compare", `${song}/compare?a=${first.split("/c/")[1]}&b=${(await (async () => { await go(`${song}?branch=bass-rework`); return page.locator(".commit-title").first().getAttribute("href"); })()).split("/c/")[1]}`);
  await shot("graph", `${song}/graph`, { schemes: ["dark"] });
  await shot("save", first, { schemes: ["dark"] });
  await shot("merge", `${song}/merge?from=bass-rework`, { schemes: ["dark"] });
  await shot("home", "/", { schemes: ["dark"] });
} finally {
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(shots.join("\n"));
