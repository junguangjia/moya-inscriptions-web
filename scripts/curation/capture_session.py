"""Optional capture-event metadata; revisions never fabricate ReviewDecisions."""
from datetime import date, datetime
import json
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from registry import CurationError, canonical, stable_id


FIELDS = {"label", "captured_at", "timezone", "location", "photographer", "device", "notes"}


def validate_metadata(metadata, provenance):
    if not isinstance(metadata, dict) or not set(metadata) <= FIELDS:
        raise CurationError("CAPTURE_METADATA_INVALID")
    if any(v is not None and (not isinstance(v, str) or len(v) > (4000 if k == "notes" else 240)
           or any(ord(c) < 32 and c not in "\n\t" for c in v)) for k, v in metadata.items()):
        raise CurationError("CAPTURE_METADATA_INVALID")
    when = metadata.get("captured_at")
    if when:
        try:
            if len(when) == 10:
                date.fromisoformat(when)
            else:
                datetime.fromisoformat(when.replace("Z", "+00:00"))
        except ValueError:
            raise CurationError("CAPTURE_DATE_INVALID") from None
    timezone = metadata.get("timezone")
    if timezone:
        try:
            ZoneInfo(timezone)
        except (ValueError, ZoneInfoNotFoundError):
            raise CurationError("CAPTURE_TIMEZONE_INVALID") from None
    if not isinstance(provenance, dict) or not set(provenance) <= {"kind", "source", "actor"} or provenance.get("kind") not in {"manual", "exif", "import", "unknown"}:
        raise CurationError("CAPTURE_PROVENANCE_REQUIRED")
    if any(not isinstance(v, str) or not v.strip() or len(v) > 240 or any(ord(c) < 32 for c in v) for v in provenance.values()):
        raise CurationError("CAPTURE_PROVENANCE_INVALID")
    # No device, timezone, date or reviewer is inferred from folder/file times.
    return dict(metadata), dict(provenance)


def read(registry, capture_id):
    row = registry.db.execute("SELECT * FROM capture_sessions WHERE id=?", (capture_id,)).fetchone()
    if row is None:
        raise CurationError("CAPTURE_SESSION_UNKNOWN")
    revisions = [{**dict(r), "metadata": json.loads(r["metadata"]), "provenance": json.loads(r["provenance"])}
                 for r in registry.db.execute("SELECT * FROM capture_session_revisions WHERE capture_session_id=? ORDER BY revision", (capture_id,))]
    if not revisions:
        raise CurationError("CAPTURE_SESSION_INCOMPLETE")
    latest = revisions[-1]
    associations = registry.rows("""SELECT a.*,o.logical_asset_id,o.batch_id,o.session_id FROM capture_asset_associations a
        JOIN asset_occurrences o ON o.id=a.occurrence_id WHERE a.capture_session_id=? ORDER BY a.created,a.id""", (capture_id,))
    return {"id": capture_id, "created": row["created"], "revision": latest["revision"],
            "metadata": latest["metadata"], "provenance": latest["provenance"],
            "revisions": revisions, "associations": associations}


def save(registry, capture_id, metadata, provenance, *, expected_revision, occurrence_ids=()):
    metadata, provenance = validate_metadata(metadata, provenance)
    if not isinstance(occurrence_ids, (list, tuple)) or len(occurrence_ids) > 50 or any(not isinstance(x, str) or not x for x in occurrence_ids) or len(set(occurrence_ids)) != len(occurrence_ids):
        raise CurationError("CAPTURE_OCCURRENCE_SCOPE_INVALID")
    if type(expected_revision) is not int or expected_revision < 0:
        raise CurationError("CAPTURE_REVISION_STALE")
    db = registry.db
    if db.in_transaction:
        raise CurationError("CAPTURE_TRANSACTION_ALREADY_ACTIVE")
    db.execute("BEGIN IMMEDIATE")
    try:
        if capture_id is None:
            if expected_revision != 0:
                raise CurationError("CAPTURE_REVISION_STALE")
            capture_id = "capture-" + uuid.uuid4().hex
            db.execute("INSERT INTO capture_sessions VALUES(?,?)", (capture_id, time.time()))
        old = db.execute("SELECT max(revision) FROM capture_session_revisions WHERE capture_session_id=?", (capture_id,)).fetchone()[0]
        exists = bool(db.execute("SELECT 1 FROM capture_sessions WHERE id=?", (capture_id,)).fetchone())
        if not exists:
            raise CurationError("CAPTURE_SESSION_UNKNOWN")
        if expected_revision != (old or 0):
            raise CurationError("CAPTURE_REVISION_STALE")
        for oid in occurrence_ids:
            if not db.execute("SELECT 1 FROM asset_occurrences WHERE id=?", (oid,)).fetchone():
                raise CurationError("CAPTURE_OCCURRENCE_UNKNOWN")
        revision = (old or 0) + 1
        rid = stable_id("capture-revision", capture_id, revision)
        now = time.time()
        db.execute("INSERT INTO capture_session_revisions VALUES(?,?,?,?,?,?)", (rid, capture_id, revision, canonical(metadata), canonical(provenance), now))
        for oid in occurrence_ids:
            aid = stable_id("capture-association", capture_id, oid)
            db.execute("INSERT OR IGNORE INTO capture_asset_associations VALUES(?,?,?,?,?)", (aid, capture_id, oid, rid, now))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return read(registry, capture_id)


def create(registry, metadata=None, provenance=None, *, occurrence_ids=()):
    metadata, provenance = validate_metadata({} if metadata is None else metadata, {"kind": "unknown"} if provenance is None else provenance)
    return save(registry, None, metadata, provenance, expected_revision=0, occurrence_ids=occurrence_ids)
