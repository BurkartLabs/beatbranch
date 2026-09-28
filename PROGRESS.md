# PROGRESS — beatbranch

A rewritten handoff, not a diary.

## Now true (2026-09-27)

The website's S1–S6 backlog is built and merged (PRs !1104 to !1141). Words on screen follow the plain-language table
in `docs/DESIGN.md` ("Words we use").

- **Accounts**: register, sign in and out, Google and Discord (off until their Key Vault secrets exist), profile and
  handle with a monthly change, delete account. The first account is the admin: reports, approvals, plans.
- **Songs**: create, details, who can see it, tags, picture (re-encoded by ffmpeg), open for remix, delete.
- **Saves**: project file + instrument tracks + full song + samples zip; each file stored once by SHA-256; 2 GB Free,
  50 GB Plus quotas (no billing); downloads through 5-minute signed links bound to the person asking.
- **Ideas**: start from any save, switch without reloading, remove or throw away, "How the song grew" graph, and three
  ways to use an idea in the Main version (as it is; pick instruments for Ableton and Reaper; combine by hand).
- **Inside a project**: FL Studio, Ableton, Reaper and Studio One read into instrument lanes, piano rolls, effects,
  sends and sounds (available or missing); Bitwig and Logic show details only. Parsing runs in a worker thread with
  memory and time limits; zip bombs and path traversal are refused; an unreadable file is saved and says so.
- **Listening**: waveforms made on the server, instrument tracks in sync with mute, solo and volume, full-song
  fallback, a preview mix for sample-only projects, A/B of two saves keeping your place, comments at a time in the song.
- **What changed**: grouped list, highlighted timeline, changed audio side by side.
- **People**: invite links with a role, comments, activity feed, Explore by genre and remix, report and approval,
  own copies with credit both ways, releases.
- **Security**: a two-account probe walks every song route as a stranger and as nobody.
- **Deploy**: `Dockerfile`; hq `ops/infra/beatbranch/` (bicep, `deploy.ps1`, RUNBOOK). Not deployed: the Board runs it.

## Blind class, stated

Every parser is tested against fixtures written from the published formats, not against a real FL Studio, Ableton,
Reaper, Studio One, Bitwig or Logic file. The first real file from the Board's brother is the real test. The Ableton
and Reaper writers are checked by reading their output back, not by opening it in the DAW.

## Next

Paused for the Board's review of the website. Then the FL Studio helper (the new work items filed 2026-09-27).
