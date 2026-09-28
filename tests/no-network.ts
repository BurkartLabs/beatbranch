// Loaded before every test file: the network is off (job-hunt's rule, T-079 "turn the network off in test setup").
// The Azure blob adapter is the only thing that would reach out, and its tests pass their own fake client.
globalThis.fetch = (async () => {
  throw new TypeError("the network is off in tests");
}) as typeof fetch;
