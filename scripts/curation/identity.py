"""Stable local content identities and explicit, reviewed object aliases.

Content equality says nothing about physical-object identity. These helpers never
rewrite legacy rows, native tasks, decisions, facts, or publication bindings.
"""
import json
import time
from pathlib import Path

from registry import CurationError, digest, file_hash, safe_source, stable_id


def _db(registry):
    return registry.db if hasattr(registry, "db") else registry


def canonical_asset(registry, asset_id):
    db = _db(registry)
    row = db.execute("SELECT logical_asset_id FROM asset_aliases WHERE asset_id=?", (asset_id,)).fetchone()
    if row is None:
        raise CurationError("ASSET_UNKNOWN")
    return row[0]


def occurrences(registry, asset_id):
    db = _db(registry)
    aid = canonical_asset(db, asset_id)
    rows = db.execute("""SELECT o.*,s.source_root,
        (o.synthetic AND s.synthetic) AS effective_synthetic
        FROM asset_occurrences o JOIN sessions s ON s.id=o.session_id
        WHERE o.logical_asset_id=? ORDER BY o.created,o.id""", (aid,))
    return [{**dict(row), "synthetic": bool(row["effective_synthetic"])} for row in rows]


def asset_synthetic(registry, asset_id):
    origins = occurrences(registry, asset_id)
    return bool(origins) and all(o["synthetic"] for o in origins)


def original_source(registry, asset_id, occurrence_id=None):
    """Return a hash-verified original occurrence; never substitute a preview."""
    rows = occurrences(registry, asset_id)
    if occurrence_id is not None:
        rows = [r for r in rows if r["id"] == occurrence_id]
        if not rows:
            raise CurationError("SOURCE_OCCURRENCE_UNKNOWN")
    changed = False
    for row in rows:
        try:
            path = safe_source(row["source_root"], Path(row["source_root"]) / row["relative_path"])
            if file_hash(path) != row["sha256"]:
                changed = True
                continue
        except (CurationError, OSError):
            continue
        return {**row, "path": path}
    raise CurationError("SOURCE_HASH_CHANGED" if changed else "SOURCE_UNAVAILABLE_OR_OUTSIDE_SELECTION")


def original_path(registry, asset_id, occurrence_id=None):
    return original_source(registry, asset_id, occurrence_id)["path"]


def register_occurrence(registry, asset_id, batch_id, session_id, relative_path, sha256, synthetic):
    """Caller has verified the selected bytes; insert alongside asset/batch writes."""
    db = _db(registry)
    row = db.execute("SELECT sha256 FROM assets WHERE id=?", (asset_id,)).fetchone()
    if row is None or row[0] != sha256:
        raise CurationError("ASSET_CONTENT_MISMATCH")
    db.execute("INSERT OR IGNORE INTO logical_assets VALUES(?,?)", (asset_id, sha256))
    aid = db.execute("SELECT id FROM logical_assets WHERE sha256=?", (sha256,)).fetchone()[0]
    db.execute("INSERT OR IGNORE INTO asset_aliases VALUES(?,?)", (asset_id, aid))
    oid = stable_id("occurrence", batch_id, session_id, relative_path, sha256)
    db.execute("INSERT OR IGNORE INTO asset_occurrences VALUES(?,?,?,?,?,?,?,?,?)",
               (oid, aid, asset_id, batch_id, session_id, relative_path, sha256, int(synthetic), time.time()))
    return db.execute("SELECT id FROM asset_occurrences WHERE batch_id=? AND session_id=? AND relative_path=? AND sha256=?",
                      (batch_id, session_id, relative_path, sha256)).fetchone()[0]


def resolve_object(registry, object_id):
    """Resolve explicit alias events; returning an ID never implies approval."""
    db = _db(registry)
    if not db.execute("SELECT 1 FROM objects WHERE id=?", (object_id,)).fetchone():
        raise CurationError("OBJECT_UNKNOWN")
    seen = set()
    while True:
        if object_id in seen:
            raise CurationError("OBJECT_ALIAS_CYCLE")
        seen.add(object_id)
        row = db.execute("SELECT target_object_id FROM object_alias_events WHERE object_id=? ORDER BY revision DESC LIMIT 1", (object_id,)).fetchone()
        if row is None:
            return object_id
        object_id = row[0]


def object_conflicts(registry, source_id, target_id):
    db = _db(registry)
    # Already recorded aliases retain their own facts/bindings. A subsequent alias
    # must not hide a conflict on an earlier member of either identity component.
    source_root, target_root = resolve_object(db, source_id), resolve_object(db, target_id)
    components = {source_root: [], target_root: []}
    for row in db.execute("SELECT id FROM objects"):
        root = resolve_object(db, row[0])
        if root in components:
            components[root].append(row[0])
    facts, bindings = [], []
    for source in components[source_root]:
        for target in components[target_root]:
            if source == target:
                continue
            facts.extend(dict(r) for r in db.execute("""SELECT a.object_id AS source_object_id,b.object_id AS target_object_id,
                a.field,a.value AS source_value,b.value AS target_value FROM facts a JOIN facts b ON a.field=b.field
                WHERE a.object_id=? AND b.object_id=? AND a.value<>b.value""", (source, target)))
            bindings.extend(dict(r) for r in db.execute("""SELECT a.local_id AS source_object_id,b.local_id AS target_object_id,
                a.instance,a.kind,a.server_id AS source_server_id,b.server_id AS target_server_id FROM bindings a
                JOIN bindings b ON a.instance=b.instance AND a.kind=b.kind
                WHERE a.local_id=? AND b.local_id=? AND a.server_id<>b.server_id""", (source, target)))
    return {"facts": facts, "bindings": bindings}


def record_object_alias(registry, source_id, target_id, decision_id, *, whole_object_confirmed=False, expected_revision=0):
    """Record a separate whole-object intent supported by an exact collected group.

    Empty cards, hash equality, reassignment alone, and same_physical_object
    proposals never call this implicitly. Conflicts must be handled explicitly.
    """
    if whole_object_confirmed is not True:
        raise CurationError("WHOLE_OBJECT_CONFIRMATION_REQUIRED")
    db = _db(registry)
    # BEGIN IMMEDIATE serializes the decision/binding/scope baseline with insertion.
    if db.in_transaction:
        raise CurationError("IDENTITY_TRANSACTION_ALREADY_ACTIVE")
    db.execute("BEGIN IMMEDIATE")
    try:
        resolve_object(db, source_id)
        if resolve_object(db, target_id) == source_id or source_id == target_id:
            raise CurationError("OBJECT_ALIAS_CYCLE")
        # Keep historical endpoints visible, rather than silently retargeting an alias.
        if resolve_object(db, target_id) != target_id:
            raise CurationError("OBJECT_ALIAS_TARGET_CHANGED")
        prior = db.execute("SELECT * FROM object_alias_events WHERE object_id=? ORDER BY revision DESC LIMIT 1", (source_id,)).fetchone()
        if prior and prior["target_object_id"] == target_id and prior["decision_id"] == decision_id:
            db.commit()
            return dict(prior)
        revision = prior["revision"] if prior else 0
        if type(expected_revision) is not int or expected_revision != revision:
            raise CurationError("OBJECT_ALIAS_REVISION_STALE")
        row = db.execute("""SELECT d.*,p.subject,p.kind,p.value AS proposed,p.version,p.field,t.mapping
            FROM decisions d JOIN proposals p ON p.id=d.proposal_id JOIN tasks t ON t.task_key=d.task_key
            WHERE d.id=?""", (decision_id,)).fetchone()
        if not row or row["subject"] != source_id or row["kind"] != "group" or row["status"] not in {"accepted", "corrected"}:
            raise CurationError("OBJECT_ALIAS_REVIEW_REQUIRED")
        latest = db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind='group'", (source_id,)).fetchone()[0]
        mapping, proposed, reviewed = json.loads(row["mapping"]), json.loads(row["proposed"]), json.loads(row["value"])
        if row["version"] != latest or mapping.get("subject_id") != source_id or mapping.get("proposal_ids") != [row["proposal_id"]] or mapping.get("asset_order") != proposed:
            raise CurationError("OBJECT_ALIAS_SCOPE_STALE")
        expected = set(proposed)
        if not expected or len(expected) != len(proposed) or len(reviewed) != len(expected) or {v.get("asset_id") for v in reviewed} != expected:
            raise CurationError("WHOLE_OBJECT_REVIEW_REQUIRED")
        if any(v.get("membership") != "reassign" or v.get("target") != target_id for v in reviewed):
            raise CurationError("WHOLE_OBJECT_REVIEW_REQUIRED")
        if db.execute("SELECT 1 FROM object_assets WHERE object_id=?", (source_id,)).fetchone():
            raise CurationError("WHOLE_OBJECT_REVIEW_REQUIRED")
        for aid in expected:
            current = db.execute("SELECT decision_id FROM object_assets WHERE object_id=? AND asset_id=?", (target_id, aid)).fetchone()
            if not current or current[0] != decision_id:
                raise CurationError("OBJECT_ALIAS_SCOPE_STALE")
        conflicts = object_conflicts(db, source_id, target_id)
        if conflicts["bindings"]:
            raise CurationError("OBJECT_ALIAS_BINDING_CONFLICT")
        if conflicts["facts"]:
            raise CurationError("OBJECT_ALIAS_FACT_CONFLICT")
        scope_hash = digest({"source": source_id, "target": target_id, "decision": decision_id, "assets": proposed})
        eid = stable_id("object-alias", scope_hash)
        db.execute("INSERT INTO object_alias_events VALUES(?,?,?,?,?,?,?)",
                   (eid, source_id, target_id, decision_id, revision + 1, scope_hash, time.time()))
        result = dict(db.execute("SELECT * FROM object_alias_events WHERE id=?", (eid,)).fetchone())
        db.commit()
        return result
    except Exception:
        db.rollback()
        raise
