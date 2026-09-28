-- Projects, members, tags (AB#2747, AB#2758, AB#2780; DESIGN "Accounts and projects").
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
  daw TEXT NOT NULL CHECK (daw IN ('fl-studio', 'ableton', 'logic', 'reaper', 'studio-one', 'bitwig', 'other')),
  genre TEXT NOT NULL DEFAULT '',
  subgenre TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'idea' CHECK (state IN ('idea', 'sketch', 'arrangement', 'mixing', 'mastering', 'released')),
  bpm INTEGER CHECK (bpm IS NULL OR (bpm >= 20 AND bpm <= 999)),
  musical_key TEXT NOT NULL DEFAULT '',
  cover_blob TEXT,
  -- An admin's takedown (AB#3748): hidden from everyone but its members and admins, with the reason shown to the owner.
  hidden_at BIGINT,
  hidden_reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (owner_id, slug)
);
CREATE INDEX projects_public ON projects (visibility, updated_at DESC);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator', 'listener')),
  added_at BIGINT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id);

CREATE TABLE project_tags (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (project_id, tag)
);

-- Reports from anyone who can see a project (AB#3748): read by an admin, never shown to the reported owner by name.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  reporter_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE INDEX reports_open ON reports (resolved_at, created_at);
