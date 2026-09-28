// Writes version.json at the repo root, once, from the checkout `npm run build` runs in (T-086: a running build must
// be able to say what it is). The server only ever reads this file, never git. Every field that cannot be answered
// honestly is null, not a guess.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tryGit(...args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const commit = tryGit("rev-parse", "HEAD");
const commitShort = tryGit("rev-parse", "--short", "HEAD");
const date = tryGit("log", "-1", "--format=%cI", "HEAD");
const behindRaw = tryGit("rev-list", "--count", "HEAD..origin/main");
const behindOrigin = behindRaw !== null && /^\d+$/.test(behindRaw) ? Number(behindRaw) : null;

/** @type {import("../src/version.js").BuildVersion} */
const manifest = { version: pkg.version, commit, commitShort, date, builtAt: Date.now(), behindOrigin };
fs.writeFileSync(path.join(repoRoot, "version.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`build-version: v${pkg.version} ${commitShort ?? "no git commit found"}${date ? ` (${date})` : ""}${behindOrigin === null ? "" : `, ${behindOrigin} behind origin/main`}`);
