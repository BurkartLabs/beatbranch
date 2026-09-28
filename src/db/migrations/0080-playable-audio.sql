CREATE TABLE audio_playable (
  blob_hash TEXT PRIMARY KEY REFERENCES blobs (hash) ON DELETE CASCADE,
  playable_hash TEXT REFERENCES blobs (hash),
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
