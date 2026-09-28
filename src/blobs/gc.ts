import type { Db } from "../db/db.js";
import type { BlobStore } from "./store.js";

export async function recountAccount(db: Db, userId: string): Promise<void> {
  await db.run(
    `DELETE FROM account_blobs a WHERE a.user_id = ? AND NOT EXISTS (
       SELECT 1 FROM commit_files f JOIN commits c ON c.id = f.commit_id WHERE f.blob_hash = a.blob_hash AND c.author_id = a.user_id)
     AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.cover_blob = a.blob_hash AND p.owner_id = a.user_id)`,
    [userId]
  );
}

export async function collectGarbage(db: Db, store: BlobStore): Promise<number> {
  const orphans = await db.all<{ hash: string }>(
    `SELECT b.hash FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM commit_files f WHERE f.blob_hash = b.hash)
     AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.cover_blob = b.hash) AND NOT EXISTS (SELECT 1 FROM commit_previews v WHERE v.blob_hash = b.hash)`
  );
  for (const { hash } of orphans) {
    await db.transaction(async () => {
      await db.run("DELETE FROM account_blobs WHERE blob_hash = ?", [hash]);
      await db.run("DELETE FROM blobs WHERE hash = ?", [hash]);
    });
    await store.remove(hash);
  }
  return orphans.length;
}
