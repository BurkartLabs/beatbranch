import type { Deps } from "../app.js";
import { modelOf, type Commit } from "../commits/repo.js";
import type { Access } from "../projects/repo.js";
import { projectPath } from "../projects/views.js";
import { html, trusted, type Html } from "../web/html.js";
import { plural } from "../web/words.js";
import { Model, type Pattern, type Track } from "./model.js";

export const PALETTE = ["#ff6a3d", "#3fa7ff", "#56d364", "#d2a8ff", "#f2cc60", "#ff7b9c", "#39c5bb", "#a5a5ff", "#ffa657", "#7ee787"];
const PX_PER_BEAT = 14;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export function trackColor(i: number): string {
  return PALETTE[i % PALETTE.length]!;
}

function lane(t: Track, i: number, widthBeats: number, prefix: string): Html {
  const w = Math.max(1, Math.ceil(widthBeats)) * PX_PER_BEAT;
  const color = trackColor(i);
  const bars = [];
  for (let b = 0; b <= widthBeats; b += 4) bars.push(`<line x1="${b * PX_PER_BEAT}" y1="0" x2="${b * PX_PER_BEAT}" y2="32" class="bar-line"/>`);
  const rects = t.clips.map((c) => {
    const x = c.start * PX_PER_BEAT;
    const width = Math.max(3, c.length * PX_PER_BEAT - 1);
    const rect = `<rect x="${x}" y="3" width="${width}" height="26" rx="4" fill="${color}" fill-opacity="${c.kind === "audio" ? 0.55 : 0.85}"/><text x="${x + 5}" y="20" class="clip-label">${esc(c.name.slice(0, Math.max(0, Math.floor(width / 7))))}</text>`;
    return c.pattern ? `<a href="#${prefix}pr-${slug(c.pattern)}">${rect}</a>` : rect;
  });
  return trusted(`<svg class="lane-svg" width="${w}" height="32" viewBox="0 0 ${w} 32" role="img" aria-label="${esc(t.name)}: ${t.clips.length} blocks">${bars.join("")}${rects.join("")}</svg>`);
}

function pianoRoll(p: Pattern, color: string): Html {
  if (!p.notes.length) return html`<p class="muted">No notes in this block.</p>`;
  const lo = Math.max(0, Math.min(...p.notes.map((n) => n.key)) - 2);
  const hi = Math.min(127, Math.max(...p.notes.map((n) => n.key)) + 2);
  const rows = hi - lo + 1;
  const length = Math.max(p.lengthBeats, ...p.notes.map((n) => n.start + n.length), 4);
  const bw = 32;
  const rh = 10;
  const w = Math.ceil(length) * bw;
  const h = rows * rh;
  const grid: string[] = [];
  for (let k = lo; k <= hi; k++) if ([1, 3, 6, 8, 10].includes(k % 12)) grid.push(`<rect x="0" y="${(hi - k) * rh}" width="${w}" height="${rh}" class="pr-black"/>`);
  for (let b = 0; b <= length; b++) grid.push(`<line x1="${b * bw}" y1="0" x2="${b * bw}" y2="${h}" class="${b % 4 === 0 ? "pr-bar" : "pr-beat"}"/>`);
  const notes = p.notes.map((n) => `<rect x="${n.start * bw}" y="${(hi - n.key) * rh + 1}" width="${Math.max(2, n.length * bw - 1)}" height="${rh - 2}" rx="2" fill="${color}" fill-opacity="${0.45 + n.velocity * 0.55}"><title>${NOTE_NAMES[n.key % 12]}${Math.floor(n.key / 12) - 1}</title></rect>`);
  const labels = [];
  for (let k = lo; k <= hi; k++) if (k % 12 === 0) labels.push(`<text x="2" y="${(hi - k) * rh + rh - 1}" class="pr-label">C${k / 12 - 1}</text>`);
  return trusted(`<div class="pr-scroll"><svg class="pr-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${p.notes.length} notes">${grid.join("")}${notes.join("")}${labels.join("")}</svg></div>`);
}

export function renderModel(m: Model, prefix = ""): Html {
  const width = Math.max(m.lengthBeats, 16);
  const facts: Html[] = [];
  facts.push(html`<span><strong>${m.tempo ? `${Math.round(m.tempo * 100) / 100} BPM` : "Tempo unknown"}</strong></span>`);
  if (m.timeSignature) facts.push(html`<span>${m.timeSignature[0]}/${m.timeSignature[1]}</span>`);
  if (m.key) facts.push(html`<span>Key: ${m.key}</span>`);
  facts.push(html`<span>${m.app}</span>`);
  if (!m.metadataOnly) facts.push(html`<span>${plural(m.tracks.length, "instrument")}</span>`);
  const missing = m.samples.filter((s) => !s.bundled).length;
  const patternColor = new Map<string, string>();
  m.tracks.forEach((t, i) => t.clips.forEach((c) => c.pattern && !patternColor.has(c.pattern) && patternColor.set(c.pattern, trackColor(i))));
  return html`<div class="model" data-format="${m.format}">
  <p class="meta model-facts">${facts}</p>
  ${m.metadataOnly ? html`<p class="flash ok">${m.notes.filter((n) => /private format/.test(n)).join(" ") || "BeatBranch can only see this project's details, not its tracks."}</p>` : ""}
  ${m.notes.filter((n) => !/private format/.test(n)).map((n) => html`<p class="muted">${n}</p>`)}
  ${m.tracks.length ? html`<div class="lanes" role="list">
    ${m.tracks.map((t, i) => html`<div class="lane" role="listitem" id="${prefix}lane-${slug(t.id)}">
      <a class="lane-name" href="#${prefix}track-${slug(t.id)}"><span class="swatch swatch-${String(i % PALETTE.length)}"></span>${t.name}</a>
      <div class="lane-track">${lane(t, i, width, prefix)}</div>
    </div>`)}
  </div>
  <div class="targets">
    ${m.tracks.map((t) => html`<section class="target" id="${prefix}track-${slug(t.id)}">
      <h3>${t.name}</h3>
      <p class="muted">Sound makers and effects, in order:</p>
      ${t.plugins.length ? html`<ol class="chain">${t.plugins.map((p) => html`<li>${p}</li>`)}</ol>` : html`<p class="muted">None.</p>`}
      ${t.sends.length ? html`<p class="muted">Also sends its sound to: ${t.sends.join(", ")}</p>` : ""}
      <a class="button quiet" href="#${prefix}close">Close</a>
    </section>`)}
    ${m.patterns.map((p) => html`<section class="target" id="${prefix}pr-${slug(p.id)}">
      <h3>${p.name}</h3>
      <p class="muted">${plural(p.notes.length, "note")}</p>
      ${pianoRoll(p, patternColor.get(p.id) ?? PALETTE[0]!)}
      <a class="button quiet" href="#${prefix}close">Close</a>
    </section>`)}
  </div>` : ""}
  ${m.samples.length ? html`<h3>Sounds this project uses</h3>
  <p class="muted">${missing ? `${plural(missing, "sound")} missing: not in the samples zip, so a collaborator won't have ${missing === 1 ? "it" : "them"}.` : "Every sound is in the samples zip."}</p>
  <ul class="samples">${m.samples.map((s) => html`<li class="${s.bundled ? "sample-ok" : "sample-missing"}"><span class="badge ${s.bundled ? "badge-ok" : "badge-missing"}">${s.bundled ? "Available" : "Missing"}</span> <span class="file-name">${s.name}</span></li>`)}</ul>` : ""}
</div>`;
}

export async function projectView(deps: Deps, a: Access, c: Commit | null, where: "commit" | "branch"): Promise<Html> {
  const title = where === "branch" ? "Inside the project" : "Inside this save";
  if (!c) return html``;
  if (c.parseStatus === "pending") return html`<section class="panel"><h2>${title}</h2><p class="muted">Still reading the project file. Refresh in a moment.</p></section>`;
  const raw = await modelOf(deps.db, c.id);
  if (c.parseStatus !== "ok") {
    const reason = raw && typeof raw === "object" && "error" in raw ? String((raw as { error: unknown }).error) : "";
    return html`<section class="panel"><h2>${title}</h2><p class="flash error">BeatBranch couldn't read this project file${reason ? html`: ${reason}` : "."} It is still saved, and you can download it.</p></section>`;
  }
  const parsed = Model.safeParse(raw);
  if (!parsed.success) return html`<section class="panel"><h2>${title}</h2><p class="flash error">BeatBranch couldn't read this project file. It is still saved, and you can download it.</p></section>`;
  const more = where === "branch" ? html` <a href="${projectPath(a.project)}/c/${c.id}">From the save “${c.message.split("\n")[0]}”</a>` : html``;
  return html`<section class="panel project-view"><h2>${title}</h2>${more}${renderModel(parsed.data, where === "branch" ? "b-" : "c-")}</section>`;
}
