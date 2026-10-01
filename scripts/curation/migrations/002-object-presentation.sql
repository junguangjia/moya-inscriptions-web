-- Private workstation presentation only; not a public Catalog identity.
CREATE TABLE IF NOT EXISTS object_presentation(
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    object_id TEXT NOT NULL UNIQUE REFERENCES objects(id),
    working_name TEXT NOT NULL DEFAULT ''
);
INSERT INTO object_presentation(object_id)
SELECT o.id FROM objects o
WHERE NOT EXISTS(SELECT 1 FROM object_presentation p WHERE p.object_id=o.id)
ORDER BY o.rowid;
CREATE TRIGGER IF NOT EXISTS object_presentation_insert
AFTER INSERT ON objects BEGIN
    INSERT INTO object_presentation(object_id) VALUES(NEW.id);
END;
INSERT OR IGNORE INTO schema_version VALUES(2);
