import type { Module } from "../app.js";
import { setModel } from "../commits/repo.js";
import { hooks } from "../hooks.js";
import { getCommit } from "../commits/repo.js";
import { parseInSandbox } from "./run.js";
import { projectView } from "./view.js";

const parsers: Module = {
  name: "parsers",
  register(_app, deps) {
    const h = hooks(deps);
    h.commit.push(async (d, project, commit, files, temps) => {
      const pf = files.find((f) => f.kind === "project")!;
      const sf = files.find((f) => f.kind === "samples");
      const r = await parseInSandbox({ daw: project.daw, name: pf.name, project: temps.get(pf.hash)!, samples: sf ? temps.get(sf.hash)! : null });
      if (r.ok) await setModel(d.db, commit.id, "ok", r.model);
      else await setModel(d.db, commit.id, "unsupported" in r && r.unsupported ? "unsupported" : "failed", { error: r.reason });
    });
    h.commitExtras.push(async (d, a, c) => projectView(d, a, c, "commit"));
    h.branchPanels.push(async (d, a, branch) => {
      if (!branch.headCommitId) return projectView(d, a, null, "branch");
      const c = await getCommit(d.db, a.project.id, branch.headCommitId);
      return projectView(d, a, c, "branch");
    });
  }
};

export default parsers;
