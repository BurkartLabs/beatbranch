ALTER TABLE users ADD COLUMN verified_at BIGINT;
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus'));
UPDATE users SET verified_at = created_at WHERE role = 'admin';

ALTER TABLE projects ADD COLUMN open_for_remix BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN forked_from TEXT REFERENCES projects (id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN forked_from_commit TEXT;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL REFERENCES commits (id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  at_ms BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX comments_commit ON comments (commit_id, created_at);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('collaborator', 'listener')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  accepted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  accepted_at BIGINT
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  commit_id TEXT NOT NULL REFERENCES commits (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX releases_project ON releases (project_id, created_at DESC);
