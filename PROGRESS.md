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
- **Accounts (AB#2716)**: `/register` (open, the Board's answer; `SIGNUP=closed` turns it off), `/login`, `/logout`;
  scrypt hashes, decoy hash for unknown emails, sign-in failures limited per address and per account, registrations
  per address; the first account is the admin. No password reset yet (owed, not in any S1 item).
- **Projects (AB#2747, AB#2913)**: /new, /p/@handle/slug, /explore, /@handle. One transaction makes the project, its
  owner membership, its `main` branch and its tags. `repo.access()` is the only way a project is read: private or
  hidden is a 404 for a non-member. Cover art moved to AB#2881.

## In flight

Nothing. AB#2747 and AB#2913 end with their pull request.

## Next, in order (one branch and one PR each, from the S1 backlog)

1. AB#2769 project page header; AB#2949 commit list; AB#2965 branch selector (the page exists: /p/@handle/slug).
2. AB#2805 commit upload, AB#2817 content addressing, AB#2834 quota (the blob store: disk now, Azure AB#3821).
3. AB#2780 visibility enforcement; AB#3765 the two-account probe; AB#2920/2933 branches; AB#2736 profile; AB#3748 report.
4. hq: `ops/infra/beatbranch/` bicep + runbook (AB#3797/3821), deployed by the Board.

## Blocked / owed

- The look tool: `npm run look` needs Playwright's Chromium (`npx playwright install chromium`) once per machine.
- No placeholder art is shipped. The landing page has no picture yet: a debt with a due date at the end of S1.
