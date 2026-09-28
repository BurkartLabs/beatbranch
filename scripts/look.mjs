#!/usr/bin/env node
/**
 * Look at the running app (CLAUDE.md "Before you say something works"; DOCTRINE P-001): screenshots of the pages a
 * person meets, at 1280x800 and 375x812, light and dark, saved under docs/looks/ for the pull request. It reads an
 * app that is already running (npm run dev), never starts one.
 *
 *   node scripts/look.mjs <baseUrl> <tag> [path ...]      e.g. node scripts/look.mjs http://127.0.0.1:4420 ab3813 / /explore
 *
 * Each page is also checked for the failure a screenshot shows but a test does not (T-073): sideways scroll, and any
 * element wider than the viewport. Findings are printed; the pictures are the evidence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const [baseUrl, tag, ...paths] = process.argv.slice(2);
if (!baseUrl || !tag) {
  console.error("usage: node scripts/look.mjs <baseUrl> <tag> [path ...]");
  process.exit(2);
}
const pages = paths.length ? paths : ["/"];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "docs", "looks");
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "375x812", width: 375, height: 812 }
];
const schemes = ["light", "dark"];

const browser = await chromium.launch();
let findings = 0;
try {
  for (const scheme of schemes) {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      for (const spec of pages) {
        // `/nowhere:404` says the status this page is meant to answer; any other 4xx or 5xx is a problem.
        const m = /^(.*?)(?::(\d{3}))?$/.exec(spec);
        const p = m?.[1] ?? spec;
        const expected = m?.[2] ? Number(m[2]) : 200;
        const url = new URL(p, baseUrl).toString();
        const res = await page.goto(url, { waitUntil: "networkidle" });
        const slug = p === "/" ? "home" : p.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        const file = path.join(outDir, `${tag}-${slug}-${size.name}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: false });
        const wide = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const over = [];
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 1) over.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).join(".") : ""} right=${Math.round(r.right)}`);
          }
          return { scrollWidth: document.documentElement.scrollWidth, vw, over: over.slice(0, 5) };
        });
        const problems = [];
        if (!res || res.status() !== expected) problems.push(`HTTP ${res?.status()}, expected ${expected}`);
        // The page's own status is not a console error worth a second report.
        if (expected >= 400) errors.splice(0, errors.length, ...errors.filter((e) => !e.includes(`status of ${expected}`)));
        if (wide.scrollWidth > wide.vw) problems.push(`sideways scroll: ${wide.scrollWidth} > ${wide.vw}`);
        if (wide.over.length) problems.push(`past the viewport: ${wide.over.join("; ")}`);
        if (errors.length) problems.push(`console: ${errors.join(" | ")}`);
        findings += problems.length;
        console.log(`${path.relative(root, file)}${problems.length ? `  PROBLEMS: ${problems.join(" / ")}` : ""}`);
        errors.length = 0;
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(findings ? `${findings} problem(s) found: look at the pictures.` : "no sideways scroll, nothing past the viewport, no console errors: now look at the pictures.");
process.exit(findings ? 1 : 0);
