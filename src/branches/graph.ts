import { html, trusted, type Html } from "../web/html.js";
import type { GraphNode } from "./repo.js";
import { ideaName } from "../web/words.js";

const COLORS = ["#ff6a3d", "#3fa7ff", "#56d364", "#d2a8ff", "#f2cc60", "#ff7b9c", "#39c5bb", "#a5a5ff"];
const ROW = 44;
const LANE = 26;

export function graphSvg(nodes: GraphNode[], href: (id: string) => string): Html {
  const lanes = new Map<string, number>();
  const ordered = [...nodes].sort((a, b) => (a.branchName === "main" ? -1 : b.branchName === "main" ? 1 : 0));
  for (const n of ordered) if (!lanes.has(n.branchId)) lanes.set(n.branchId, lanes.size);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const x = (n: GraphNode) => 16 + (lanes.get(n.branchId) ?? 0) * LANE;
  const y = (i: number) => 22 + i * ROW;
  const width = 16 + Math.max(1, lanes.size) * LANE + 8;
  const edges: string[] = [];
  nodes.forEach((n, i) => {
    for (const p of [n.parentId, n.parent2Id]) {
      if (!p) continue;
      const j = index.get(p);
      if (j === undefined) continue;
      const parent = nodes[j]!;
      const color = COLORS[(lanes.get(p === n.parent2Id ? parent.branchId : n.branchId) ?? 0) % COLORS.length];
      const x1 = x(n), y1 = y(i), x2 = x(parent), y2 = y(j);
      edges.push(x1 === x2 ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.5"/>` : `<path d="M${x1} ${y1} C ${x1} ${y1 + ROW / 1.4}, ${x2} ${y2 - ROW / 1.4}, ${x2} ${y2}" stroke="${color}" stroke-width="2.5" fill="none"/>`);
    }
  });
  const dots = nodes.map((n, i) => `<circle cx="${x(n)}" cy="${y(i)}" r="6" fill="${COLORS[(lanes.get(n.branchId) ?? 0) % COLORS.length]}" stroke="var(--surface)" stroke-width="2"/>`);
  const svg = trusted(`<svg class="graph-svg" width="${width}" height="${y(nodes.length - 1) + 22}" viewBox="0 0 ${width} ${y(nodes.length - 1) + 22}" aria-hidden="true">${edges.join("")}${dots.join("")}</svg>`);
  return html`<div class="graph">${svg}<ol class="graph-rows">${nodes.map(
    (n) => html`<li><a href="${href(n.id)}">${n.message.split("\n")[0]}</a> <span class="graph-idea" data-lane="${String((lanes.get(n.branchId) ?? 0) % COLORS.length)}">${ideaName(n.branchName)}</span>${n.parent2Id ? html` <span class="badge">brought together</span>` : ""}</li>`
  )}</ol></div>`;
}
