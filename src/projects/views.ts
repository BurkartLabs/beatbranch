// How a project is drawn: the card in a list, the header of its page (AB#2769 refines the header with the branch
// selector and the commit list). Pure functions of data: nothing here reads the database.
import { html, type Html } from "../web/html.js";
import { dawName, stateName } from "./catalogue.js";
import type { Project } from "./repo.js";

export const projectPath = (p: Pick<Project, "ownerHandle" | "slug">): string => `/p/@${p.ownerHandle}/${p.slug}`;

/** "2 Mar 2026" from a millisecond time: fixed names, not the platform's locale data (T-061). */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function visibilityBadge(p: Pick<Project, "visibility">): Html {
  return p.visibility === "public" ? html`` : html`<span class="badge">${p.visibility === "private" ? "Private" : "Unlisted"}</span>`;
}

export function projectCard(p: Project, options: { showArtist?: boolean } = {}): Html {
  return html`<article class="card project-card">
  <h3><a href="${projectPath(p)}">${p.name}</a> ${visibilityBadge(p)}</h3>
  ${options.showArtist === false ? "" : html`<p class="muted">by <a href="/@${p.ownerHandle}">${p.ownerName}</a></p>`}
  <p class="meta"><span>${dawName(p.daw)}</span><span>${stateName(p.state)}</span>${p.bpm ? html`<span>${String(p.bpm)} BPM</span>` : ""}${p.genre ? html`<span>${p.subgenre ? `${p.genre} · ${p.subgenre}` : p.genre}</span>` : ""}</p>
</article>`;
}

export function projectGrid(projects: Project[], empty: Html, options: { showArtist?: boolean } = {}): Html {
  if (!projects.length) return html`<p class="empty">${empty}</p>`;
  return html`<div class="grid">${projects.map((p) => projectCard(p, options))}</div>`;
}
