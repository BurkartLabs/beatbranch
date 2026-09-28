// The running build's own identity (T-086: a product that can be deployed must be able to say what it is running).
// scripts/build-version.mjs writes the manifest once at `npm run build`; nothing here queries git live. Missing or
// unreadable is null, never a guess.
import fs from "node:fs";

export interface BuildVersion {
  /** package.json's version: major.minor.feature.fix (AB#3838). */
  version: string;
  commit: string | null;
  commitShort: string | null;
  date: string | null;
  builtAt: number;
  behindOrigin: number | null;
}

export function readVersion(versionFile: string): BuildVersion | null {
  try {
    return JSON.parse(fs.readFileSync(versionFile, "utf8")) as BuildVersion;
  } catch {
    return null;
  }
}
