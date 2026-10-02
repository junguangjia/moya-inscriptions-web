-- Capture events are independent from selected source folders and ingestion batches.
CREATE TABLE IF NOT EXISTS capture_sessions(
    id TEXT PRIMARY KEY,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_session_revisions(
    id TEXT PRIMARY KEY,
    capture_session_id TEXT NOT NULL REFERENCES capture_sessions(id),
    revision INTEGER NOT NULL CHECK(revision>0),
    metadata TEXT NOT NULL,
    provenance TEXT NOT NULL,
    created REAL NOT NULL,
    UNIQUE(capture_session_id,revision)
);
CREATE TABLE IF NOT EXISTS capture_asset_associations(
    id TEXT PRIMARY KEY,
    capture_session_id TEXT NOT NULL REFERENCES capture_sessions(id),
    occurrence_id TEXT NOT NULL REFERENCES asset_occurrences(id),
    revision_id TEXT NOT NULL REFERENCES capture_session_revisions(id),
    created REAL NOT NULL,
    UNIQUE(capture_session_id,occurrence_id)
);
CREATE TRIGGER IF NOT EXISTS immutable_capture_revision_update BEFORE UPDATE ON capture_session_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE_REVISION'); END;
CREATE TRIGGER IF NOT EXISTS immutable_capture_revision_delete BEFORE DELETE ON capture_session_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE_REVISION'); END;
CREATE TRIGGER IF NOT EXISTS immutable_capture_association_update BEFORE UPDATE ON capture_asset_associations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE_ASSOCIATION'); END;
CREATE TRIGGER IF NOT EXISTS immutable_capture_association_delete BEFORE DELETE ON capture_asset_associations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE_ASSOCIATION'); END;
INSERT OR IGNORE INTO schema_version VALUES(4);
