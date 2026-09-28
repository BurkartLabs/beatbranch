# BeatBranch

A place where a producer registers, creates a project (public or private), uploads the DAW project file — FL Studio, Ableton, Logic, Reaper, Studio One, Bitwig — and from then on works the way developers do: branches, commits with a message, diffs that show what changed, merges when the other branch was better, invites and forks; and where the site can actually **see inside** the project — tracks, patterns, tempo, plugins, samples — and play the stems in the browser.

**Orchestrata product** — slug `beatbranch`, kind `saas`, stage **Build** (since 2026-09-27), rank 20. Registered
2026-09-26 at the Board's instruction; the Board moved it to Build on 2026-09-27 and answered the three design Decisions
(docs/DESIGN.md, "Decisions for the Board"). The Board steers this product directly; `PROGRESS.md` is the handoff.

- **Design document:** [docs/DESIGN.md](docs/DESIGN.md) — the full packet: who it is for, what is already known, the RUBRIC gate
  scores, the kill number, the product design, stack, security at design time, workstreams and the Decisions the Board owes.
- **Brief:** [BRIEF.md](BRIEF.md) — the one-page summary in the company's template shape.
- **Work items:** Azure DevOps, area `Orchestrata\beatbranch`, epic AB#2526. Product repos and the design stack that governs them: the
  `hq` repo (`README.md` lists the reading order).

## Running it

A TypeScript Fastify server on PostgreSQL, server-rendered HTML, no framework, no inline script (strict CSP). Node 22+.

```
npm ci
npm run dev        # an embedded PostgreSQL 17 in .embedded-postgres/ plus the server at http://127.0.0.1:4420
npm run check      # typecheck, then the suite on a throwaway embedded Postgres, judged by what executed
npm run look -- http://127.0.0.1:4420 <tag> / /explore   # screenshots into docs/looks/ (look at them)
```

`npm test -- <path>` runs the files matching a filter. The suite needs no Docker: `scripts/embedded-postgres.mjs` starts a
real PostgreSQL for the run and removes it after (T-090). A full run takes the machine's suite lock, so two runs on one
PC take turns (T-041).

## Settings

Read from the environment once at start-up and validated (`src/config.ts`); a bad value stops start-up naming the variable.
Secrets are read by name through `secret()` from the environment or `DATA_DIR/.env`, never logged or rendered.

- `DATABASE_URL` (secret, required): `postgres://user:password@host:5432/db?sslmode=verify-full`. Off localhost, TLS is
  required and the server's certificate is always checked (T-105).
- `HOST` (127.0.0.1), `PORT` (4420), `PUBLIC_URL` (the address people use; its scheme decides `Secure` cookies and HSTS).
- `TRUST_PROXY` (`false`): `true` only behind Container Apps' ingress, exactly one hop (T-094).
- `SIGNUP` (`open`, the Board's answer AB#4685) or `closed`.
- `DATA_DIR` (`%LOCALAPPDATA%/beatbranch`): the disk blob store and `.env`.
- `BLOB_STORE` (`disk`) or `azure` with `AZURE_STORAGE_ACCOUNT` and `AZURE_BLOB_CONTAINER` (`blobs`); the identity is the
  process's own (managed identity in Azure, `az login` on a PC).
- `STORAGE_QUOTA_BYTES` (2 GiB per account, AB#4686's default), `BLOB_URL_TTL_SECONDS` (300).
- `LOG_LEVEL` (`info`; `silent` in tests). Logs carry ids, counts and codes only.
