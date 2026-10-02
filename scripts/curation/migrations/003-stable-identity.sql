-- Additive content identity. Legacy asset/object rows and all review references stay intact.
CREATE TABLE IF NOT EXISTS logical_assets(
    id TEXT PRIMARY KEY REFERENCES assets(id),
    sha256 TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS asset_aliases(
    asset_id TEXT PRIMARY KEY REFERENCES assets(id),
    logical_asset_id TEXT NOT NULL REFERENCES logical_assets(id)
);
CREATE TABLE IF NOT EXISTS asset_occurrences(
    id TEXT PRIMARY KEY,
    logical_asset_id TEXT NOT NULL REFERENCES logical_assets(id),
    source_asset_id TEXT NOT NULL REFERENCES assets(id),
    batch_id TEXT NOT NULL REFERENCES batches(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)),
    created REAL NOT NULL,
    UNIQUE(batch_id,session_id,relative_path,sha256)
);
CREATE INDEX IF NOT EXISTS asset_occurrences_asset ON asset_occurrences(logical_asset_id);
CREATE INDEX IF NOT EXISTS asset_occurrences_batch ON asset_occurrences(batch_id);
INSERT OR IGNORE INTO logical_assets(id,sha256)
SELECT a.id,a.sha256 FROM assets a
WHERE a.rowid=(SELECT min(b.rowid) FROM assets b WHERE b.sha256=a.sha256);
INSERT OR IGNORE INTO asset_aliases(asset_id,logical_asset_id)
SELECT a.id,l.id FROM assets a JOIN logical_assets l ON l.sha256=a.sha256;
INSERT OR IGNORE INTO asset_occurrences
SELECT 'occurrence-legacy-'||a.id||'-'||ba.batch_id,l.logical_asset_id,a.id,ba.batch_id,origin.session_id,
       a.relative_path,a.sha256,s.synthetic,b.created
FROM assets a JOIN asset_aliases l ON l.asset_id=a.id
JOIN batch_assets ba ON ba.asset_id=a.id JOIN batches b ON b.id=ba.batch_id
JOIN batches origin ON origin.id=a.batch_id JOIN sessions s ON s.id=origin.session_id
WHERE NOT EXISTS(SELECT 1 FROM schema_version WHERE version=3);
CREATE TABLE IF NOT EXISTS object_alias_events(
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL REFERENCES objects(id),
    target_object_id TEXT NOT NULL REFERENCES objects(id),
    decision_id TEXT NOT NULL REFERENCES decisions(id),
    revision INTEGER NOT NULL CHECK(revision>0),
    scope_hash TEXT NOT NULL,
    created REAL NOT NULL,
    CHECK(object_id<>target_object_id),
    UNIQUE(object_id,revision),
    UNIQUE(object_id,target_object_id,decision_id)
);
CREATE TRIGGER IF NOT EXISTS immutable_object_alias_update BEFORE UPDATE ON object_alias_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBJECT_ALIAS'); END;
CREATE TRIGGER IF NOT EXISTS immutable_object_alias_delete BEFORE DELETE ON object_alias_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBJECT_ALIAS'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_occurrence_update BEFORE UPDATE ON asset_occurrences BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ASSET_OCCURRENCE'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_occurrence_delete BEFORE DELETE ON asset_occurrences BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ASSET_OCCURRENCE'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_alias_update BEFORE UPDATE ON asset_aliases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ASSET_ALIAS'); END;
CREATE TRIGGER IF NOT EXISTS immutable_asset_alias_delete BEFORE DELETE ON asset_aliases BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ASSET_ALIAS'); END;
INSERT OR IGNORE INTO schema_version VALUES(3);
