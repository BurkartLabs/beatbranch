import type { FastifyRequest } from "fastify";
import type { Deps } from "../app.js";
import { hooks } from "../hooks.js";
import type { Access } from "../projects/repo.js";
import { html, type Html } from "../web/html.js";
import type { Commit, CommitFile } from "./repo.js";

export async function commitExtras(deps: Deps, a: Access, c: Commit, files: CommitFile[], audio: CommitFile[], req: FastifyRequest): Promise<Html> {
  const parts: Html[] = [];
  for (const e of hooks(deps).commitExtras) parts.push(await e(deps, a, c, files, audio, req));
  return html`${parts}`;
}
