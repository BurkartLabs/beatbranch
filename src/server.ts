// Start beatbranch: read the settings, open and migrate the database, serve. The address is printed; no secret is.
import fs from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig, secret } from "./config.js";
import { openDatabase } from "./db/db.js";
import { readVersion } from "./version.js";

async function main() {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = await openDatabase(secret(config, "DATABASE_URL"), { onIdleError: (e) => console.error(`database: ${(e as Error).message}`) });
  const app = await buildApp(config, db);
  const close = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await app.listen({ host: config.host, port: config.port });
  const v = readVersion(config.versionFile);
  console.log(`beatbranch v${v?.version ?? "?"} (${v?.commitShort ?? "no commit"}) is running at ${config.publicUrl} (blobs: ${config.blobStore}, data in ${config.dataDir})`);
}

main().catch((error: Error) => {
  console.error(`beatbranch could not start: ${error.message}`);
  process.exit(1);
});
