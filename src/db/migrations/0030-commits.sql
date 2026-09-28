-- Branches, commits, content-addressed blobs (AB#2805, AB#2817, AB#2834, AB#2913, AB#2920, AB#2986; DESIGN
-- "Uploads and the version model").
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY, -- SHA-256, hex
  size BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  head_commit_id TEXT, -- NULL until the first commit; the reference to commits is added below
  created_at BIGINT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES commits (id),
  -- A manual merge records both parents (AB#3210), so history is a graph like Git's.
  parent2_id TEXT REFERENCES commits (id),
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  -- The parser's verdict: pending until a worker runs, ok with a model, failed with "could not read this project"
  -- (AB#2872, fail closed), or unsupported for a format nothing parses yet.
  parse_status TEXT NOT NULL DEFAULT 'pending' CHECK (parse_status IN ('pending', 'ok', 'failed', 'unsupported')),
  model_json JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX commits_branch ON commits (branch_id, created_at DESC);
CREATE INDEX commits_project ON commits (project_id, created_at DESC);
ALTER TABLE branches ADD CONSTRAINT branches_head FOREIGN KEY (head_commit_id) REFERENCES commits (id);

-- The files a commit carries: one project file, any number of stems, at most one bounce and one sample bundle.
CREATE TABLE commit_files (
  commit_id TEXT NOT NULL REFERENCES commits (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'stem', 'bounce', 'samples')),
  name TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs (hash),
  size BIGINT NOT NULL,
  content_type TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (commit_id, kind, name)
);
CREATE INDEX commit_files_blob ON commit_files (blob_hash);

-- What counts against an account's quota (AB#2834): each blob once per account, however many commits reference it.
CREATE TABLE account_blobs (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blob_hash TEXT NOT NULL REFERENCES blobs (hash),
  added_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, blob_hash)
);
