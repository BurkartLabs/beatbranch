-- Accounts and sessions (AB#2716, AB#2736; DESIGN "Accounts and projects"). Times are epoch milliseconds.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'producer' CHECK (role IN ('producer', 'admin')),
  handle_changed_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Rate limits that hold across restarts and processes (job-hunt JH-76's shape; AB#2141's single-statement count).
CREATE TABLE rate_limits (
  limit_name TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  hits INTEGER NOT NULL,
  reset_at BIGINT NOT NULL,
  PRIMARY KEY (limit_name, limit_key)
);
