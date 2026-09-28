// Where the repo is on disk, found the same way from src (tests) and from dist (npm start): walk up from this file to
// the folder holding package.json. Static files and migrations are read from there, so the build copies nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function repoRoot(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return (cached = dir);
    const up = path.dirname(dir);
    if (up === dir) throw new Error("beatbranch: package.json not found above " + fileURLToPath(import.meta.url));
    dir = up;
  }
}
