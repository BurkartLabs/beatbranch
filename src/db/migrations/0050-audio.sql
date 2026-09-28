CREATE TABLE audio_peaks (
  blob_hash TEXT PRIMARY KEY REFERENCES blobs (hash) ON DELETE CASCADE,
  duration_ms BIGINT NOT NULL,
  peaks JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE commit_previews (
  commit_id TEXT PRIMARY KEY REFERENCES commits (id) ON DELETE CASCADE,
  blob_hash TEXT REFERENCES blobs (hash),
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
