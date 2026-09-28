import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { parseProject } from "./parse.ts";

const job = workerData as { daw: string; name: string; project: string; samples: string | null };
const result = parseProject({ daw: job.daw, name: job.name, project: fs.readFileSync(job.project), samples: job.samples ? fs.readFileSync(job.samples) : null });
parentPort!.postMessage(result);
