// Loaded before every test file: its afterAll runs after every describe's own afterAll, closing and dropping the
// databases made outside a test.
import { afterAll } from "vitest";
import { discardPendingTestDbs } from "./test-db.js";

afterAll(() => discardPendingTestDbs());
