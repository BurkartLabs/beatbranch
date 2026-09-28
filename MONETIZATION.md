# MONETIZATION — beatbranch

## Review #1 — 2026-09-27 · **1.7 / 5 · REPRICE**

Reviewer: Monetization Critic (fresh context) · probes: none exist for beatbranch monetization (`ops/probes/beatbranch-*` not found; `tests/probe.test.ts` exercises the signup/upload probe, not spend)
Stage: **Build**, pre-Preview. There is no billing, no SKU and no price anywhere in the product; the only monetization-shaped thing that exists is a per-account storage quota and an admin-set "plus" flag that raises it. This review scores the *plan* in `docs/DESIGN.md` ("Monetization (later)") against the code that implements its only live mechanism, not a shipped paid tier.
Previous score: none (first review).

### What is already known

- **Splice Studio** (2013–2023) is the direct precedent: free DAW-project version control and collaboration, 3 GB
  free, paid tiers historically $9.99–$19.99/month for more storage and collaboration. Splice never charged enough
  for Studio to cover it and shut it down in 2023 to focus on the sample marketplace, which did monetize. [Splice
  Studio — CDM](https://cdm.link/splice-studio-is-free-backup-version-control-and-collaboration-for-your-daw/),
  [Splice plans](https://splice.com/plans). This is the same lesson DESIGN.md already draws; it means a beatbranch
  storage/collaborator tier is competing with a price point the market has already tried and found unsustainable at
  low volume.
- **BandLab**: mostly free with unlimited real-time collaboration; a paid membership ($14.95/mo, or $99 first year)
  sells more tracks, AI tools and priority mixing, not storage or collaborator seats. [BandLab pricing —
  toolradar](https://toolradar.com/tools/bandlab/pricing)
- **Soundtrap**: paid-first, "Basic" $5/mo for 5 users and 1 GB storage, rising to ~$14/mo. Storage and collaborator
  count are the paid axis here, closest to what beatbranch's own Decision (AB#4686) already gates. [Soundtrap
  pricing — toolradar](https://toolradar.com/tools/soundtrap/pricing)
- **Audiomovers**: a different product shape (live audio streaming, not storage/version control); no permanently
  free tier, $10–30/month. Not a close comparable for a storage quota. [Audiomovers pricing](https://www.audiomovers.com/pricing/)
- **General cloud storage for musicians**: prices cluster from ~$7–10/month for 100 GB–unlimited (Feedtracks) up to
  $36/month for 100 GB from a collaboration-specific tool, i.e. storage-with-collaboration commands a premium over
  raw storage. [Feedtracks](https://feedtracks.com/blog/best-cloud-storage-for-music-producers)
- No industry survey found on producers' specific willingness to pay for DAW-project version control (as opposed to
  samples, mixing or distribution). Searched "what will producers pay for cloud storage collaboration DAW project
  files survey" and adjacent terms; nothing on point turned up. Absence of data noted, not filled with a guess.
- **Conclusion for this review**: the two closest comparables that charge specifically for storage/collaborators
  (Soundtrap, historical Splice Studio) sit in the $5–20/month band, and the one company that tried exactly
  beatbranch's wedge (version control for DAW projects) could not make that band cover its costs alone. This
  matters for the epics below, not for a price — the Critic prices nothing.

### Honesty (pass/fail, judged first) — **PASS**

- **No dark patterns, because nothing is for sale.** There is no checkout, no SKU, no price shown to a user
  anywhere in the codebase (`grep` for `$`/`pay`/`price`/`upgrade` across `src/` turns up nothing user-facing; the
  only match is in the admin-only `/admin/reports` "Storage plans" panel, `src/social/module.ts:208-210`, which
  states plainly to the admin *"Nobody is charged: billing isn't built."*).
- **The quota message is not misleading.** `src/commits/module.ts:177`: `"That would use {X} of your {Y}. Nothing
  was stored."` — factual, states the exact numbers, doesn't imply a purchase would fix it, doesn't mention "Plus."
  The upload form shows the same numbers before the user tries (`commits/module.ts:59`).
- **Files are not held hostage by the quota.** Checked directly in code: the file-download route
  (`GET /p/@:handle/:slug/c/:id/f/:pos`, `src/commits/module.ts:210-221`) and the raw blob route (`/blob/:hash`)
  gate only on project access/membership, never on storage quota — a user over quota can still download every file
  they own. Account deletion (`POST /settings/delete`, `src/settings/module.ts:184-194`) has no quota check either
  and deletes the account's songs and unshared files outright. So a full account is neither locked out of its own
  data nor prevented from leaving; the quota only blocks *new* uploads once exceeded.
- **No fake urgency, scarcity, inflated "was" price, fabricated social proof, or hidden odds**: none of these
  concepts exist in the code — there are no offers, no countdowns, no "X people bought this," no loot.
- **Minors**: signup is open (`SIGNUP=open`, README) with no age gate found, but there are zero paid mechanics of
  any kind, let alone paid random rewards, so the minors clause of this gate has nothing to fail. Flagging open
  signup with no age check as a separate, non-monetization safety question for the Board — it is outside this
  gate's "paid random rewards" scope but adjacent to it.

### Scores (RUBRIC Monetization table)

| Gate | Score | Evidence |
|---|---|---|
| Value perception | 1 — cannot be evaluated | No SKU exists to price against minutes of play; the only paid-shaped object is an admin-toggled quota flag with no user-facing price. |
| Sink depth | 1 — cannot be evaluated | No currency, soft or hard, and nothing to spend it on; there is no sink at all. |
| Price ladder | 1 — cannot be evaluated | No prices exist anywhere in the product to form a ladder. |
| Spend moments | 1 — cannot be evaluated | There are no offer surfaces; the only quota-adjacent moment is a refusal message on upload, and it does not offer anything to buy. |
| Free path | 5 | Every route that reads or writes a project — upload, branch, diff, merge, comment, playback, invite, fork, release — works with no payment mechanism anywhere in the code; the entire product is free today, trivially, because there is nothing to pay for yet. This is a true pass, not a designed one: it says the current build blocks nothing behind money, not that a future free tier will stay generous once one exists. |
| Spending runway | 1 — cannot be evaluated | Nothing is purchasable at any price, so there is no runway to measure, deep or shallow. |
| **Average (floor applied)** | **1.7 / 5** | (1+1+1+1+5+1)/6, per RUBRIC's rule that a gate with no subject scores the floor. |
| **Evaluable-only average** | **5.0 / 5 (n=1)** | Only Free path had a subject. A one-gate average is not a meaningful monetization score — it says the product isn't paywalled yet, nothing about whether a future paywall would be healthy. Reported per RUBRIC/T-024 so the floor-applied number isn't read as worse than it is, not as a result to act on. |
| Honesty | **PASS** | See above: no dark pattern found; quota does not hold files or accounts hostage; nothing is sold. |

### Verdict: **REPRICE**

Honesty passes, so this is not COERCIVE. The floor-applied average (1.7) is far below the HEALTHY bar (≥3.5, none
below 2), but that reflects a monetization plan that has not been built yet, not a broken one — 5 of 6 gates score
the floor only because they have no subject, exactly RUBRIC's documented case for an early product (compare ISP's
first review: 1.8/5 with the floor applied). REPRICE is the correct verdict because DESIGN.md already commits to
building a paid tier before Live, and the honest reading of "cannot be evaluated ×5" is that the plan needs the
design work below before it can be scored for real, not that the current code is unhealthy.

### Epics (≤5, ranked)

| # | Epic | Hypothesis | Probe target |
|---|---|---|---|
| 1 | Price the storage/collaborator SKU against our own infra cost, not a guess | If the Plus tier is priced below what the extra Blob Storage + compute actually costs us per account (Hot LRS $0.02/GB/month, B1ms ≈$13.50/month per DESIGN.md), it can never be healthy regardless of what producers would pay; the price floor is a cost calculation the Critic can check but not set. | A cost model in `docs/DESIGN.md` or a new `docs/PRICING.md`: $/GB-month and $/collaborator-seat-month derived from the actual Azure bill, published before any price is proposed to the Board. |
| 2 | Prove the free tier survives real usage before threatening it with a paywall | 2 GB free (AB#4686) may already be generous or already be tight for a producer who commits stems weekly; we don't know which, and Splice's failure mode was charging for something producers didn't value enough to pay for. | Instrument `usedBytes` per active account over the brother's + 10 invited producers' first 4 weeks (the BRIEF's own kill-number window); probe: median and p90 storage used per active project per week against the 2 GiB ceiling. |
| 3 | Design spend moments around delight, not the quota wall, before building billing | DOCTRINE's own hypothesis (P-003: "first dollar is a small pack timed off delight or jam, not a wall at boot") applies here too — a quota-exceeded refusal is structurally a wall, the worst possible spend moment even once it becomes a real offer. | Before wiring a real Plus purchase flow, define in DESIGN.md at least one non-wall trigger (e.g. offered after a successful merge or a release, never mid-upload-failure) and probe it with a fake-door "Upgrade" link's click-through rate, not a real charge. |
| 4 | Decide what "Plus" actually buys, beyond raw GB | Every comparable that survives on this wedge (Soundtrap) sells collaborator seats and storage together, not storage alone; beatbranch's Plus today is only `storageQuotaPlusBytes` — no collaborator-seat concept exists in the schema. | A design note answering whether Plus also raises the invite/collaborator limit (none currently enforced) or stays storage-only, checked against Soundtrap's $5–14/mo band cited above. |
| 5 | Do not price anything until the kill number says the product is used | BRIEF.md's own kill number (commits/active project/week, target >1, ideally >3) is the gate for whether the versioning idea works at all; pricing a feature nobody uses yet risks repeating Splice Studio's mistake at a smaller scale. | Hold this Monetization Critique's next cycle until BRIEF's kill number has at least one 4-week reading from the brother's cohort; the next review should open with that number. |

### Charter and Soul risks checked

- **Monetize advantage, collection, space and convenience — never access** (DOCTRINE): the only real mechanism,
  storage quota, gates *space* (more room to store files), not access to a project's own content — checked directly
  in code above (downloads and deletion are quota-blind). No violation found.
- **No energy gates, no fake urgency/scarcity/FOMO timers**: none exist in the code; checked by grep and by reading
  every route that touches storage or plans.
- **"A brief inherits Soul"** (P-002): DESIGN.md's Monetization section makes no false-urgency, inflated-baseline or
  fabricated-social-proof claim to patch; it is a plain, honest one-paragraph plan.
- **Revenue never buys back a failed Honesty gate**: not applicable here — Honesty passed, and there is no revenue
  yet to test that principle against.

### What this review could not measure (blind class)

- **Any real pricing signal.** No price has ever been shown to a real producer, so nothing here can say what the
  brother or the ten invited producers would actually pay, or at what point a quota starts to hurt. That gap is
  exactly why 5 of 6 gates score the floor rather than a guess.
- **Collaborator-seat economics**, because the schema doesn't model a seat limit yet — only bytes.
- **Whether open signup with no visible age check interacts with a future paid tier** (a minors/COPPA-adjacent
  question) — noted above as out of this gate's literal scope (paid random rewards) but worth the Board's attention
  before Plus becomes a real purchase.
- **Whether the admin-only "Storage plans" panel is ever used to move a real human to Plus** — no usage data exists
  because the product isn't live to invited producers yet.

### Next review

Due when either: (a) a real Plus purchase flow exists (this review's REPRICE epics are meant to precede that, not
follow it), or (b) BRIEF's kill number has a first 4-week reading, whichever comes first.
