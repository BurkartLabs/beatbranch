import type { Deps } from "../app.js";
import { hooks } from "../hooks.js";
import type { Project } from "../projects/repo.js";
import type { Commit, StagedFile } from "./repo.js";
import { setModel } from "./repo.js";

export async function afterCommit(deps: Deps, project: Project, commit: Commit, files: StagedFile[], temps: Map<string, string>): Promise<void> {
  const list = hooks(deps).commit;
  if (!list.length) {
    await setModel(deps.db, commit.id, "unsupported", null);
    return;
  }
  for (const h of list) await h(deps, project, commit, files, temps);
}
