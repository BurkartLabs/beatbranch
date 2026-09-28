# PROGRESS — beatbranch

A rewritten handoff, not a diary: what is true now, what is in flight, what the next session does first.

## Now true (2026-09-27, AB#3813)

- **Stage Build** since 2026-09-27; the Board steers this product directly. Decisions answered: FL Studio first
  (AB#4684), public from day one (AB#4685), Azure from the first PR (AB#4686). `docs/DESIGN.md` has the answers.
- **Scaffold**: Fastify 5 + TypeScript on PostgreSQL only; server-rendered HTML through the escaping `html` tag,
  strict CSP, security headers on every response class, sign-in guard (`config.public` per route, `is404` public),
  same-origin and CSRF checks on every unsafe method, feature modules discovered from `src/*/module.ts`.
- **Schema** (migrations 0010–0030): users (handle, role, first account is admin), sessions, rate_limits, projects
  (visibility, DAW, state, bpm, hidden_at for takedowns), project_members, project_tags, reports, blobs (SHA-256),
  branches, commits (two parents, parse_status), commit_files, account_blobs (the quota's ledger).
- **Tests** run on a real embedded PostgreSQL 17 per run (`scripts/embedded-postgres.mjs`), one migrated template
  database copied per test (`tests/test-db.ts`), judged by what executed (`scripts/strict-pass.mjs`).
- **Dev**: `npm run dev` starts an embedded Postgres in `.embedded-postgres/` and the server on :4420.
- **Pages**: the front door (`/`: a pitch signed out, "your projects" signed in), `/healthz`, `/version`, a 404.

## In flight

Nothing. AB#3813 ends with its pull request.

## Next, in order (one branch and one PR each, from the S1 backlog)

1. AB#2716 register with email/password (+ login/logout, the `auth` module, rate limits already in `limits.ts`).
2. AB#2913 default `main` branch on project creation, with AB#2747 create a project.
3. AB#2769 project page header; AB#2949 commit list; AB#2965 branch selector.
4. AB#2805 commit upload, AB#2817 content addressing, AB#2834 quota (the blob store: disk now, Azure AB#3821).
5. AB#2780 visibility enforcement; AB#3765 the two-account probe; AB#2920/2933 branches; AB#2736 profile; AB#3748 report.
6. hq: `ops/infra/beatbranch/` bicep + runbook (AB#3797/3821), deployed by the Board.

## Blocked / owed

- The look tool: `npm run look` needs Playwright's Chromium (`npx playwright install chromium`) once per machine.
- No placeholder art is shipped. The landing page has no picture yet: a debt with a due date at the end of S1.
