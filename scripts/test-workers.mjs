/**
 * How much of the machine one vitest run may take (job-hunt AB#2144, T-041). Half the cores leaves the other half
 * for the other products' suites that run on the same PC at the same time; the suite lock (suite-lock.mjs) makes
 * beatbranch's own runs take turns, and cannot see another repo's.
 */
export const MAX_WORKERS = "50%";
