import type { Deps } from "../app.js";
import type { Project } from "../projects/repo.js";
import type { StagedFile, Commit } from "./repo.js";
import { setModel } from "./repo.js";

export type Parser = (deps: Deps, project: Project, commit: Commit, files: StagedFile[], temps: Map<string, string>) => Promise<void>;

const parsers: Parser[] = [];

export function onCommit(parser: Parser): void {
  parsers.push(parser);
}

export async function afterCommit(deps: Deps, project: Project, commit: Commit, files: StagedFile[], temps: Map<string, string>): Promise<void> {
  if (!parsers.length) {
    await setModel(deps.db, commit.id, "unsupported", null);
    return;
  }
  for (const p of parsers) await p(deps, project, commit, files, temps);
}
