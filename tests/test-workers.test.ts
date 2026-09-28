// AB#2144, AB#4768: several agents run their suites on one PC at once. vitest's default (a worker per core less one)
// sizes each run for an idle machine, so together they oversubscribe it and tests time out or never run. The config
// take their bound from scripts/test-workers.mjs; these tests keep it set and keep it small.

import { describe, expect, it } from "vitest";
import { MAX_WORKERS, workers } from "../scripts/test-workers.mjs";
import config from "../vitest.config.js";

describe("test worker bound", () => {
  it("is two workers unless TEST_MAX_WORKERS says otherwise", () => {
    expect(MAX_WORKERS).toBe(workers(process.env.TEST_MAX_WORKERS, 2));
    if (!process.env.TEST_MAX_WORKERS) expect(MAX_WORKERS).toBe(2);
  });

  it("takes a count or a percentage from the environment, and nothing else", () => {
    expect(workers("6", 2)).toBe(6);
    expect(workers("50%", 2)).toBe("50%");
    for (const bad of [undefined, "", "0", "-1", "0%", "150%", "lots", "2.5"]) expect(workers(bad, 2)).toBe(2);
  });

  it("is what the vitest config uses", () => {
    expect(config.test?.maxWorkers).toBe(MAX_WORKERS);
  });
});
