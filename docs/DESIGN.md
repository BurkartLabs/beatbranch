# BeatBranch — GitHub for music producers

**Portfolio status:** stage Build since 2026-09-27, kind `saas`. The Board named the user it is for: their younger
brother, a producer.

## Words we use (Board, 2026-09-27: "dumbed down so a 5 year old could understand it")

Version control is a developer's idea, and its words confuse everyone else. Every screen, message and new work item
uses the plain word on the left. The developer word on the right stays in code, URLs and this document only.

| On screen | In the code | What it means to a producer |
|---|---|---|
| a save / Save a new version | commit | a copy of the song kept forever, so you can always go back |
| What did you change? | commit message | a few words about this version |
| an idea / Try a new idea | branch | a copy where you try something without changing the Main version |
| the Main version | `main` | the song as it is now |
| Use this idea in the Main version | merge | keep what you tried |
| Use the idea as it is / Pick instruments from each / Combine them yourself | take-branch / per-track / manual merge | the three ways to keep an idea |
| brought an idea in | merge commit (two parents) | a save that combined two versions |
| Throw this idea away | abandon / delete branch | stop trying it |
| What changed | diff / compare | the differences between two saves |
| How the song grew | commit graph | every save and idea, as a picture |
| Make my own copy | fork | take a public song and change it yourself |
| Release this version | tag a release | mark a save as finished, with its full song |
| Instrument tracks | stems | one audio file per instrument |
| Full song | bounce | the whole mix as one audio file |
| Samples zip | sample bundle | the sounds a project uses |
| People / Can save new versions / Can listen and comment | members / collaborator / listener | who's on the song |

## One sentence

A place where a producer registers, creates a project (public or private), uploads the DAW project file — FL
Studio, Ableton, Logic, Reaper, Studio One, Bitwig — and from then on works the way developers do: branches, commits
with a message, diffs that show what changed, merges when the other branch was better, invites and forks; and where
the site can actually **see inside** the project — tracks, patterns, tempo, plugins, samples — and play the stems in
the browser.

## The verb

Upload a project. See it. A silent screenshot is a project page: a header with the artist and the BPM, a branch
selector, a commit list ("v3 — brought the bass down, new hat pattern"), and below it a track lane view with
waveforms and a play button. That screenshot says "GitHub, but the code is music" without a caption.

## Who it is for, how they find it

Producers who work in a DAW and share projects by Discord and Google Drive, with filenames like
`track_final_FINAL_v7_bass2.flp`. The Board's brother first. They find it through the producer communities that
already trade project files (r/FL_Studio, r/ableton, Discord servers, "remix this stem pack" threads), through
public projects being shareable pages, and through the one feature that spreads: a link that lets a collaborator hear
a project and see how it was made without owning the DAW.

## What is already known (session knowledge as of 2026-09-26, not re-verified on the web)

- **Splice Studio** (2013–2020) did exactly this — version history for DAW projects with FL Studio, Ableton and
  Logic integration, project pages and collaboration — and Splice **shut it down** to focus on samples. The honest
  lesson: the sync client was the expensive part, samples were the business, and producers did not pay for
  versioning. This product must be cheaper to run (no desktop sync client at preview) and must give a reason to
  return that Studio lacked: being able to *see and hear* a project in the browser, and a real merge.
- **Blend.io** (project-sharing community, closed), **Satellite** (Mixed In Key's cross-DAW collaboration plugin),
  **Audiomovers**, **BandLab** (browser DAW with forks and a huge free community — the closest living thing, but you
  must use *their* DAW), **Soundtrap**, **Endlesss**. Git itself with LFS is used by some producers and is hostile
  to them.
- **Formats**: Ableton `.als` is gzipped XML (readable, structurally diffable, writable); Reaper `.rpp` is plain
  text; Studio One `.song` and Bitwig `.bwproject` are zip containers with XML inside; **FL Studio `.flp`** is a
  binary event stream that the open-source `pyflp` library parses (channels, patterns, arrangement, mixer, plugin
  state, sample paths); Logic `.logicx` is a package with a proprietary core (metadata only). Project files reference
  samples on the producer's disk by path; FL's "zipped loop package" and Ableton's "Collect All and Save" bundle
  them. **Nothing renders a project to audio without the DAW**: playback needs stems or a bounce, exported by the
  producer or by a companion that drives the DAW (Reaper has a full CLI render; FL Studio has a command-line
  render switch; Ableton and Logic do not).
- Nothing found that combines a real branch/merge model with a browser view of a DAW project across formats. That
  is the wedge, and it is exactly the part that is hard.

## Gate scores (RUBRIC, kind `saas`)

| Gate | Score | Evidence |
|---|---|---|
| Job to be done | 4 | "Which version is the good one, and what changed" is a real, daily producer problem; the filenames prove it. |
| Return reason | 4 | Every session in the DAW ends with a commit; collaborators' changes are a reason to open the site. |
| Bet size | 2 | Honestly **L**: an upload/version model, parsers for several formats, a browser player, structural diffs, a merge model that is honest about binary formats, accounts, invites, public pages. 12–20 builder-days to a preview the brother would use. |
| Doctrine fit | 4 | Security-first has teeth (users' unreleased music is the data); teaches the company a content-addressed storage model and its first audio product. |
| Distribution | 4 | Public project pages and "hear this project" links are the hook. |
| Measurement | 5 | Commits per active project per week, and second-week return, from the first user. |

## Kill number

**Commits per active project per week.** After the brother and ten invited producers have used it for four weeks:
below 1 commit per active project per week, it is a file drop with extra steps; above 3, the version model is
part of how they work. Second number: **share of projects with more than one branch**, which is whether the
Git-like part is used at all (target > 25%).

## Product design

### Accounts and projects

Register (email + password, or Google/Discord sign-in — producers live on Discord); a profile with a handle;
create a project: name, visibility (public / unlisted / private), genre and subgenre (a curated list), description,
state (idea / sketch / arrangement / mixing / mastering / released), tags, cover art, and the DAW.

### Uploads and the version model

- A **commit** is: the project file, plus optional **stems** (per-track WAV/FLAC), a **bounce** (the mix as WAV/MP3),
  and a **sample bundle** (the zipped package the DAW exports), with a message. Files are content-addressed
  (SHA-256) so an unchanged sample is stored once across every commit and every fork.
- **Branches**: `main` by default; create a branch from any commit ("bass-rework"); commits land on the branch you
  chose; a branch page shows its commits and how far it is from `main`.
- **Diff** between two commits: for formats we parse, a **structural diff** — tracks added/removed/renamed, patterns
  changed, tempo and key changes, plugins added, mixer routing changes, samples added/removed — shown as a list and
  as a track-lane overlay; for every format, the stem-level diff (which stems changed, with waveforms side by side)
  and the bounce A/B player (switch between the two mixes while playing, time-aligned).
- **Merge**: honest about what a binary can and cannot do. Three modes: *take this branch* (fast-forward or
  whole-file replace, the default and always available); *pick per stem/track* for formats with a writer (Ableton
  XML, Reaper text: a new project file is written with the chosen tracks — this is the real feature, and it ships
  for those two formats first); *manual merge* (the producer downloads both, merges in the DAW, commits the result
  to `main` with both parents recorded, so history is a graph like Git's).
- **Forks** of public projects, with attribution back to the source; pull requests are out of scope at preview
  (a fork owner asks in a comment; later, a "propose merge" flow).
- **Tags/releases**: mark a commit as a release with the bounce as the listenable artefact.

### Seeing inside a project

- **Parsers** run server-side in a sandbox on every upload: FL Studio via `pyflp` (channels, patterns, playlist
  arrangement, mixer inserts, plugin names, sample references, tempo, time signature); Ableton via the XML (tracks,
  clips, devices, tempo, key); Reaper via the text format; Studio One and Bitwig via their XML; Logic metadata
  only. Output is one **normalised project model** (tracks → clips/patterns → notes where available; mixer;
  plugins; samples; tempo map), stored as JSON with the commit.
- **The project view**: track lanes on a timeline, colour by track, pattern blocks, a piano-roll preview for MIDI
  patterns where the format exposes notes (FL patterns and Ableton MIDI clips do), the plugin chain per track, the
  sample list with which are bundled and which are missing, tempo and key.
- **Playback**: stems are decoded and drawn as waveforms (server-side peaks, client-side playback with the Web
  Audio API); solo/mute per stem, a master fader; the bounce plays when there are no stems. When the sample bundle
  is present and the project is simple (audio clips arranged on a timeline, no synths), the site **renders a
  preview mix from the arrangement** itself; anything with plugins needs stems — the site says so and offers the
  companion.
- **The companion** (post-preview): a small desktop app that watches a project folder, commits on save with a
  message prompt, bundles samples, and renders stems through the DAWs that have a CLI (Reaper, FL Studio), so
  "commit with stems" is one click.

### Collaboration and community

Invites per project (roles: owner, collaborator, listener); comments on a commit and on a timestamp in the player;
activity feed; explore page (public projects by genre, recently active, "open for remix" flag); a producer's page
with their public projects and releases. Moderation is the cost every community has (PORTFOLIO's build-off idea
warns of it): at preview, invited users only, public pages read-only to strangers, a report button, and no
uploads from unverified accounts.

## Platform and stack

A TypeScript web app (server: Node with Postgres and object storage for blobs — the company's Azure footprint, Blob
Storage with per-object SAS; client: a web app with Web Audio and canvas waveforms); parsers as isolated workers
(Python for `pyflp`, TypeScript for the XML/text formats) in a sandbox with size limits; ffmpeg for decoding and
peaks; the companion later in Tauri. Storage is the cost centre: content addressing, per-user quotas, and
FLAC for stems.

## Security at design time

**Data touched:** unreleased music (the users' most valuable asset), accounts, emails, collaborators' identities.
**Hostile input:** every upload is attacker-controlled — project files are parsed in a sandboxed worker with
memory and time limits (a crafted FLP or a zip bomb must fail the parse, not the server); zip extraction with path
traversal and size checks; audio decoded by ffmpeg in the same sandbox; nothing uploaded is ever served with a
content type it did not earn (images re-encoded, audio transcoded, project files download-only). **Access control:**
every object behind the project's visibility and the member list; storage URLs are short-lived and per user; the
two-account probe (RUBRIC Security) is the test that matters — a private project's stems reachable by a stranger is
the sev-1. **Personal data:** email, handle, avatar; nothing else; deletion deletes blobs that no other commit
references. **Blast radius:** blob storage keys in Key Vault; per-user quotas so a hostile account cannot fill the
disk. **Fail closed:** a parse failure stores the commit with "could not read this project" and no model, never a
partial model shown as complete.

**Likeliest sev-1:** a private project's audio served to a non-member through a guessable or long-lived URL.
Tests: `access.two-account-probe` over every route with a second account; `storage.urls-expire`.

## Monetization (later)

Free with a storage quota; a paid tier for storage and private collaborators (real money from users to us). The
Board's brother pays nothing. A Monetization Critic review before Live.

## Workstreams to preview

| # | Stream | Sessions |
|---|---|---|
| S1 | Accounts, projects, uploads with content addressing, commits and branches, the project page | 5 |
| S2 | Parsers: FL Studio (`pyflp`) and Ableton first, the normalised model, the sandbox; Reaper and the zip-XML formats after | 6 |
| S3 | Project view: lanes, patterns, piano-roll preview, plugin chain, sample list | 4 |
| S4 | Stems: decode, peaks, Web Audio player with solo/mute, bounce A/B, stem diff | 4 |
| S5 | Structural diff; merge modes (take-branch; per-track for Ableton and Reaper; manual with two parents); forks | 5 |
| S6 | Invites, comments, explore, producer pages; the two-account probe; screenshot playthrough; the brother uses it | 4 |

Size **L** honestly; the preview that the brother would use is S1–S4 (**M**), with S5–S6 the second milestone.
Carrying an L needs the Board's word (precedent AB#353); the Board's instruction to build it is taken as that.

## Decisions for the Board (answered 2026-09-27, Board session)

1. **Storage budget and hosting** (AB#4686): *deploy to Azure from the first PR*, on the job-hunt hosting pattern
   (Container App in `orch-env`, PostgreSQL Flexible Server B1ms, a Blob Storage account with per-object SAS). No
   storage number was named; the session's default, open to veto: **2 GB per account** at preview, and a cost alert
   on the storage account. Retail prices in Canada Central, read 2026-09-27 from the Azure Retail Prices API: B1ms
   compute $0.0185/hour (about $13.50/month), Hot LRS blob storage $0.02/GB/month.
2. **The brother's DAW** (AB#4684): **FL Studio (.flp)**. S2 starts with the `pyflp` worker; Ableton follows.
3. **Public projects at preview** (AB#4685): **public from day one**. Open registration, public/unlisted/private
   visibility, a report button and an owner-side takedown path are in S1 (AB#3748 moves into S1); the two-account
   probe (AB#3765) gates it.

## Out of scope

A DAW in the browser; editing project files on the site; real-time collaboration; a sample marketplace; mobile
apps at preview; Logic beyond metadata.
