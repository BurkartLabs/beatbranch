import type { Deps } from "../app.js";
import { hooks } from "../hooks.js";
import type { Project } from "../projects/repo.js";
import type { Commit, StagedFile } from "./repo.js";
import { setModel } from "./repo.js";

export async function afterCommit(deps: Deps, project: Project, commit: Commit, files: StagedFile[], temps: Map<string, string>): Promise<void> {
  const h = hooks(deps);
  if (!h.commit.length) await setModel(deps.db, commit.id, "unsupported", null);
  for (const fn of h.commit) await fn(deps, project, commit, files, temps);
  for (const fn of h.lateCommit) await fn(deps, project, commit, files, temps);
}
