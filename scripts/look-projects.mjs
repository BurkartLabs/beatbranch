#!/usr/bin/env node
/**
 * Look at projects the way a producer meets them (AB#2747): register a fresh account through the real form, create a
 * project through the real form, then photograph the new-project form, the project page, the front door, explore and
 * the producer's page, at 1280x800 and 375x812, light and dark. Seeded through the real path, never the database
 * (P-HARNESS-FICTION). Reads an app that is already running (npm run dev); leaves one throwaway account behind in
 * that dev database.
 *
 *   node scripts/look-projects.mjs <baseUrl> <tag>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const [baseUrl, tag] = process.argv.slice(2);
if (!baseUrl || !tag) {
  console.error("usage: node scripts/look-projects.mjs <baseUrl> <tag>");
  process.exit(2);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "docs", "looks");
fs.mkdirSync(outDir, { recursive: true });
const id = crypto.randomBytes(3).toString("hex");
const handle = `look-${id}`;

const browser = await chromium.launch();
let findings = 0;
try {
  // One account and one project, made once through the forms.
  const setup = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await setup.newPage();
  await page.goto(new URL("/register", baseUrl).toString());
  await page.fill("#displayName", "Midnight Cartel");
  await page.fill("#handle", handle);
  await page.fill("#email", `${handle}@example.com`);
  await page.fill("#password", "a long enough look password");
  await Promise.all([page.waitForURL(new URL("/", baseUrl).toString()), page.click("main button[type=submit]")]);
  await page.goto(new URL("/new", baseUrl).toString());
  await page.fill("#name", "Night Drive");
  await page.selectOption("#daw", "fl-studio");
  await page.selectOption("#genre", "House");
  await page.selectOption("#subgenre", "Deep house");
  await page.selectOption("#state", "arrangement");
  await page.fill("#bpm", "124");
  await page.fill("#musicalKey", "F minor");
  await page.fill("#description", "Late-night deep house sketch. The bass needs work; the hats are the good part.");
  await page.fill("#tags", "808, night, collab");
  await Promise.all([page.waitForURL(/\/p\/@/), page.click("main button[type=submit]")]);
  const projectUrl = new URL(page.url()).pathname;
  const state = await setup.storageState();
  await setup.close();

  const pages = ["/new", projectUrl, "/", "/explore", `/@${handle}`];
  for (const scheme of ["light", "dark"]) {
    for (const size of [{ name: "1280x800", width: 1280, height: 800 }, { name: "375x812", width: 375, height: 812 }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, storageState: state });
      const p = await context.newPage();
      const errors = [];
      p.on("pageerror", (e) => errors.push(String(e.message)));
      p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      for (const url of pages) {
        const res = await p.goto(new URL(url, baseUrl).toString(), { waitUntil: "networkidle" });
        const slug = url === "/" ? "home" : url === projectUrl ? "project" : url.startsWith("/@") ? "producer" : url.replace(/^\//, "");
        const file = path.join(outDir, `${tag}-${slug}-${size.name}-${scheme}.png`);
        await p.screenshot({ path: file });
        const wide = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
        const problems = [];
        if (!res || res.status() !== 200) problems.push(`HTTP ${res?.status()}`);
        if (wide.sw > wide.vw) problems.push(`sideways scroll ${wide.sw} > ${wide.vw}`);
        if (errors.length) problems.push(`console: ${errors.join(" | ")}`);
        errors.length = 0;
        findings += problems.length;
        console.log(`${path.relative(root, file)}${problems.length ? `  PROBLEMS: ${problems.join(" / ")}` : ""}`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(findings ? `${findings} problem(s): look at the pictures.` : "no sideways scroll, no console errors: now look at the pictures.");
process.exit(findings ? 1 : 0);
