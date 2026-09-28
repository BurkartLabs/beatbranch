// Loaded before every test file: its afterAll belongs to the file's root suite, so it runs after every describe's own
// afterAll, and removes the temporary folders that could not go earlier.
import { afterAll } from "vitest";
import { removePendingTempDirs } from "./temp-dir.js";

afterAll(() => removePendingTempDirs());
