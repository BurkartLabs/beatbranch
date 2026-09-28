import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Deps } from "../app.js";
import { prepareListening } from "../audio/module.js";
import { storeOf } from "../commits/module.js";
import { filesOf, setModel } from "../commits/repo.js";
import { loadConfig, secret } from "../config.js";
import { openDatabase } from "../db/db.js";
import { parseInSandbox } from "../parsers/run.js";

async function main() {
  const config = loadConfig();
  const db = await openDatabase(secret(config, "DATABASE_URL"));
  const deps: Deps = { db, config, nav: [] };
  const store = storeOf(deps);
  const commits = await db.all<{ id: string; daw: string }>("SELECT c.id, p.daw FROM commits c JOIN projects p ON p.id = c.project_id ORDER BY c.created_at");
  let done = 0;
  for (const c of commits) {
    const files = await filesOf(db, c.id);
    const dir = path.join(config.dataDir, "tmp", crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    try {
      const local = new Map<string, string>();
      for (const f of files) {
        const p = path.join(dir, f.hash);
        if (!local.has(f.hash)) {
          const chunks: Buffer[] = [];
          for await (const chunk of await store.read(f.hash)) chunks.push(Buffer.from(chunk as Buffer));
          fs.writeFileSync(p, Buffer.concat(chunks));
          local.set(f.hash, p);
        }
      }
      const pf = files.find((f) => f.kind === "project");
      const sf = files.find((f) => f.kind === "samples");
      if (pf) {
        const r = await parseInSandbox({ daw: c.daw, name: pf.name, project: local.get(pf.hash)!, samples: sf ? local.get(sf.hash)! : null });
        if (r.ok) await setModel(db, c.id, "ok", r.model);
        else await setModel(db, c.id, "unsupported" in r && r.unsupported ? "unsupported" : "failed", { error: r.reason });
      }
      await prepareListening(deps, c.id, files, local);
      done++;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`reprocessed ${done} of ${commits.length} saves`);
  await db.close();
}

main().catch((e: Error) => {
  console.error(`reprocess failed: ${e.message}`);
  process.exit(1);
});
