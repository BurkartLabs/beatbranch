import type { Deps } from "../app.js";
import type { Access } from "../projects/repo.js";
import { html, type Html } from "../web/html.js";
import type { Commit, CommitFile } from "./repo.js";

export type Extra = (deps: Deps, a: Access, c: Commit, files: CommitFile[], audio: CommitFile[]) => Promise<Html>;

const extras: Extra[] = [];

export function addCommitExtra(e: Extra): void {
  extras.push(e);
}

export async function commitExtras(deps: Deps, a: Access, c: Commit, files: CommitFile[], audio: CommitFile[]): Promise<Html> {
  const parts: Html[] = [];
  for (const e of extras) parts.push(await e(deps, a, c, files, audio));
  return html`${parts}`;
}
