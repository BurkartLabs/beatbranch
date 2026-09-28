/**
 * How many workers one test run may take (AB#4768; before it AB#2144, T-041). The configs read these, so the numbers
 * live in one committed place rather than on a command line a session can forget.
 *
 * Several agents run their suites on one PC at once, this repo's and other products'. AB#2144 bounded each run at half
 * the cores: six workers on the Board's 12-thread PC, so six agents testing at once still asked for thirty-six and the
 * CPU sat at 100% before the plan's agents were all running. A fixed two per run keeps the sum near the machine
 * whatever the agent count. A lone run, or a bigger machine, raises it: TEST_MAX_WORKERS=6, or TEST_MAX_WORKERS=50%.
 */

/** A worker count from the environment: a positive integer, or a percentage of the cores; anything else is the fallback. */
export function workers(value, fallback) {
  if (/^[1-9]\d*$/.test(value ?? "")) return Number(value);
  if (/^(100|[1-9]\d?)%$/.test(value ?? "")) return value;
  return fallback;
}

/** vitest: two, or TEST_MAX_WORKERS. */
export const MAX_WORKERS = workers(process.env.TEST_MAX_WORKERS, 2);
