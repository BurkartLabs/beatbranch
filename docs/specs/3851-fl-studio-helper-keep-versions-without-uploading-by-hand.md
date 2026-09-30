# FL Studio helper: keep versions without uploading by hand

Feature AB#3851 (Proposed) · product beatbranch · migrated from Azure DevOps on 2026-09-30 (AB#4889)

## What it is

Where it sits. beatbranch epic AB#2526, after the Board has reviewed the website (Board, 2026-09-27: the website is paused for review first).
What it is. Uploading an FL Studio file to the website after every session is too tedious to keep up. A small helper on the producer's computer does it for them: it notices when FL Studio saves the song, asks in one line what changed, and saves a new version to BeatBranch with the samples. It also lets them try an idea and switch back to the Main version without leaving their desk. AB#3861, 3871 and 3884 (written as the "companion" in the design) are parts of this.
Why it matters. The kill number is saves per active song per week; nobody will reach 3 a week by hand. Every word the helper shows follows the plain-language table in docs/DESIGN.md, "Words we use": a save, an idea, the Main version, instrument tracks, the full song. No developer words (commit, branch, merge, push, repository) on any screen.

## Acceptance

_To be written: the Feature had no acceptance criteria in Azure DevOps._

## Checklist

Each heading replaces a Requirement or Bug, which Azure DevOps keeps (Closed, tagged folded, linked here); its lines are its Acceptance. A checked line was Resolved and has not been verified. 9 open, 0 resolved.

### Watch a project folder and prompt to commit on save (Requirement AB#3861, Proposed)

What: Where it sits. Companion app. What it is. Filesystem watcher that detects a DAW project save and prompts for a commit message.

- [ ] Saving the watched project file triggers a commit prompt.

### Bundle samples automatically on commit (Requirement AB#3871, Proposed)

What: Where it sits. Companion app. What it is. Collects referenced sample files into the sample bundle automatically when committing from the companion.

- [ ] A commit made via the companion includes a sample bundle with every referenced sample.

### Drive Reaper and FL Studio CLI render for stems (Requirement AB#3884, Proposed)

What: Where it sits. Companion app. What it is. Invokes Reaper's and FL Studio's command-line render to produce stems automatically as part of a companion commit.

- [ ] Committing a Reaper project via the companion produces stems without manual export.
- [ ] Committing an FL Studio project via the companion produces stems without manual export.

### Find out the best shape for the FL Studio helper (Requirement AB#4753, Proposed)

What: What it is. Before building, find out what each option can actually do: FL Studio's own Python scripting (device and piano-roll scripts), a VST/CLAP plugin that sits in the project, or a small desktop app that watches the project folder. For each: can it see when the song is saved, find the file and its samples, show a window, reach the internet, and open a different version in FL Studio? / Why it matters. The wrong shape costs weeks. Look for what already exists first (DOCTRINE constraint 2):… (the rest: AB#4753)

- [ ] A short write-up in docs/HELPER.md answers the five questions above for each option, with sources.
- [ ] It recommends one shape and says what it can't do.
- [ ] It is checked against FL Studio 21 and 2024 on Windows, and says what differs on Mac.

### Website: a safe way for the helper to save new versions (Requirement AB#4754, Proposed)

What: What it is. The helper can't use the website's forms. It needs its own door: sign the helper in once, then let it list the producer's songs and ideas and save a new version, and nothing else. / Why it matters. This is the key to someone's unreleased music, so it is built narrow on purpose.

- [ ] Signing in: the helper shows a short code; the producer types it on the website while signed in and says yes; the helper gets its own key.
- [ ] The key can only list the producer's own songs and ideas and save new versions; it can't delete, change settings, invite people or read anyone else's songs.
- [ ] The producer sees every signed-in helper on their settings page and can switch any of them off at once.
- [ ] The key is stored hashed on the server and in the operating system's own password store on the computer, never in a file.
- [ ] Saving through the helper follows the same rules as the website: the quota, the approval, the file checks and the rate limit. A test proves a switched-off key and another person's song are both refused.

### Helper: connect an FL Studio song to a BeatBranch song (Requirement AB#4755, Proposed)

What: What it is. The producer points the helper at an FL Studio project file and picks which BeatBranch song it belongs to, or makes a new song for it. / Why it matters. Everything else starts from knowing which file is which song. Every word the helper shows follows the plain-language table in docs/DESIGN.md, "Words we use": a save, an idea, the Main version, instrument tracks, the full song. No developer words (commit, branch, merge, push, repository) on any screen.

- [ ] The producer can pick a .flp file and connect it to one of their songs, or create a new song from it, in under a minute.
- [ ] The helper remembers the connection after a restart.
- [ ] A file already connected shows which song it belongs to.

### Helper: switch between ideas without leaving your desk (Requirement AB#4756, Proposed)

What: What it is. From the helper, the producer can start a new idea, see their ideas, and switch: the helper keeps a copy of what's open, puts the idea's latest version in its place and opens it in FL Studio. Switching back to the Main version works the same way. / Why it matters. Trying ideas is the part of version control a producer actually wants, and it only feels natural if it happens where they work. Every word the helper shows follows the plain-language table in docs/DESIGN.md, "Words we use":… (the rest: AB#4756)

- [ ] Starting an idea from the helper creates it on the website from the latest save.
- [ ] Switching to an idea asks first if there are changes that haven't been saved to BeatBranch, and offers to save them.
- [ ] Switching never deletes the file that was open: a copy is kept in a backups folder the producer can find.
- [ ] The helper shows which idea is open right now, in plain words.

### Helper: use an idea in the Main version (Requirement AB#4757, Proposed)

What: What it is. When the producer likes an idea, the helper takes them to the website's "Use this idea in the Main version" page for it. / Why it matters. The website already does this three ways; the helper just needs to get there in one click.

- [ ] A button in the helper opens the right page for the open idea in the browser.
- [ ] After it's done, switching to the Main version in the helper opens the new version.

### Helper: install and update on Windows and Mac (Requirement AB#4758, Proposed)

What: What it is. A normal installer, a tray icon that starts with the computer, and updates that install themselves. / Why it matters. The Board's brother should be able to install it without help. Nothing is downloaded or run that isn't signed by us.

- [ ] One installer for Windows and one for Mac; the app starts at sign-in and sits in the tray or menu bar.
- [ ] Updates are checked, downloaded and verified against a signature before they run.
- [ ] Uninstalling removes the app and its key, and leaves the producer's music files alone.

## Demo script

_To be written._
