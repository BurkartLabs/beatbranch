import type { FastifyRequest } from "fastify";
import type { Deps } from "./app.js";
import type { Commit, CommitFile, StagedFile } from "./commits/repo.js";
import type { Access, Branch, Project } from "./projects/repo.js";
import type { Html } from "./web/html.js";

export type CommitHook = (deps: Deps, project: Project, commit: Commit, files: StagedFile[], temps: Map<string, string>) => Promise<void>;
export type CommitExtra = (deps: Deps, a: Access, c: Commit, files: CommitFile[], audio: CommitFile[], req: FastifyRequest) => Promise<Html>;
export type BranchPanel = (deps: Deps, a: Access, branch: Branch, req: FastifyRequest) => Promise<Html>;

export interface Hooks {
  commit: CommitHook[];
  commitExtras: CommitExtra[];
  branchPanels: BranchPanel[];
}

const registry = new WeakMap<object, Hooks>();

export function hooks(deps: Deps): Hooks {
  let h = registry.get(deps);
  if (!h) {
    h = { commit: [], commitExtras: [], branchPanels: [] };
    registry.set(deps, h);
  }
  return h;
}
