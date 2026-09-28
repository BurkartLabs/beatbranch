import { describe, expect, it } from "vitest";
import { connectionOptions, DatabaseConfigError, migrate, MIGRATIONS_DIR, rewritePlaceholders } from "./db.js";
import { emptyTestDb, testDb } from "../../tests/test-db.js";

describe("rewritePlaceholders", () => {
  it("numbers each ? in order and leaves quoted ones alone", () => {
    expect(rewritePlaceholders("SELECT ? WHERE a = ? AND b = '?' -- ?\n AND c = ?")).toBe("SELECT $1 WHERE a = $2 AND b = '?' -- ?\n AND c = $3");
  });
});

describe("connectionOptions (T-105)", () => {
  it("refuses a remote database without TLS, and never quotes the URL", () => {
    expect(() => connectionOptions("postgres://u:hunter2@db.example.com/x")).toThrow(DatabaseConfigError);
    try {
      connectionOptions("postgres://u:hunter2@db.example.com/x");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("hunter2");
    }
  });
  it("turns any TLS mode into verify-full with the host name pinned, and strips pg's own TLS params", () => {
    const o = connectionOptions("postgres://u:p@db.example.com:5432/x?sslmode=require");
    expect(o.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(o.connectionString).not.toContain("sslmode");
    expect(typeof (o.ssl as { checkServerIdentity: unknown }).checkServerIdentity).toBe("function");
  });
  it("allows localhost in the clear", () => {
    expect(connectionOptions("postgres://u:p@127.0.0.1:5432/x").ssl).toBeUndefined();
  });
});

describe("migrate", () => {
  it("applies every migration once and records it (AB#3813)", async () => {
    const db = await emptyTestDb();
    const first = await migrate(db, MIGRATIONS_DIR);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(await migrate(db, MIGRATIONS_DIR)).toEqual([]);
    const tables = (await db.all<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()")).map((r) => r.name).sort();
    for (const t of ["users", "sessions", "rate_limits", "projects", "project_members", "branches", "commits", "commit_files", "blobs", "account_blobs", "reports"]) expect(tables).toContain(t);
  });

  it("gives a test a migrated database of its own from the template", async () => {
    const db = await testDb();
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")).toEqual({ n: 0 });
    await db.transaction(async () => {
      await db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?)", ["a".repeat(64), 10, 1]);
      await db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?)", ["b".repeat(64), 20, 1]);
    });
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")).toEqual({ n: 2 });
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?)", ["c".repeat(64), 30, 1]);
        throw new Error("roll it back");
      })
    ).rejects.toThrow("roll it back");
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")).toEqual({ n: 2 });
  });
});
