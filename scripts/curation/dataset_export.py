"""Explicit, metadata-only Algorithm Dataset export from a read-only snapshot.

No Registry constructor, native service, original, preview, configuration or
annotation file is opened. Only whitelisted SQLite columns enter the dataset.
Current reviewed projections are separate from candidate and decision history.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time
import uuid


SCHEMA_VERSION = "artvenn-algorithm-dataset/v1"
EXPORTER_VERSION = "metadata-snapshot/v1"
SCHEMA_PATH = Path(__file__).parent / "schemas/algorithm-dataset-v1.schema.json"
MAX_OBJECTS = 100
MAX_ROWS = 100_000
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
ACCEPTED = {"accepted", "corrected"}


class DatasetError(ValueError):
    """Fixed error categories only; never include database content or paths."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def _json(value):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        raise DatasetError("DATASET_INVALID_STORED_JSON") from None


def _ids(values):
    if not isinstance(values, (list, tuple)):
        raise DatasetError("DATASET_EXPLICIT_OBJECT_SELECTION_REQUIRED")
    values = list(values)
    if not values or len(values) > MAX_OBJECTS or any(
            not isinstance(value, str) or not ID.fullmatch(value) for value in values):
        raise DatasetError("DATASET_EXPLICIT_OBJECT_SELECTION_REQUIRED")
    if len(set(values)) != len(values):
        raise DatasetError("DATASET_DUPLICATE_SELECTION")
    return sorted(values)


def _placeholders(values):
    return ",".join("?" for _ in values)


class Snapshot:
    """One SQLite transaction, finite output and explicit column projections."""

    def __init__(self, db, max_rows):
        self.db = db
        self.max_rows = max_rows
        self.read_rows = 0
        self.tables = {r[0] for r in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}

    def rows(self, sql, args=()):
        # Fetch one extra row to detect limits without materializing the rest.
        remaining = self.max_rows - self.read_rows
        rows = self.db.execute(sql, args).fetchmany(remaining + 1)
        if len(rows) > remaining:
            raise DatasetError("DATASET_ROW_LIMIT_EXCEEDED")
        self.read_rows += len(rows)
        return [dict(row) for row in rows]

    def where_ids(self, table, columns, column, values):
        if not values:
            return []
        values = sorted(set(values))
        result = []
        for start in range(0, len(values), 400):
            part = values[start:start + 400]
            result.extend(self.rows(
                f"SELECT {columns} FROM {table} WHERE {column} IN ({_placeholders(part)})", part))
        return result


def _unique(rows, key):
    return list({key(row): row for row in rows}.values())


def _expect_refs(values, available):
    if not set(values) <= set(available):
        raise DatasetError("DATASET_REFERENCE_MISSING")


def _binding_in_scope(row, object_ids, asset_ids):
    if row["kind"] != "media":
        return row["local_id"] in object_ids
    # Existing media bindings encode object:asset:derivative SHA. A donor object
    # is only a provenance reference, not permission to include unrelated media.
    for oid in object_ids:
        prefix = oid + ":"
        if row["local_id"].startswith(prefix):
            aid, separator, derivative_hash = row["local_id"][len(prefix):].rpartition(":")
            if separator and aid in asset_ids and re.fullmatch(r"[0-9a-f]{64}", derivative_hash):
                return True
    return False


def _selected_history(snapshot, selected):
    proposals = snapshot.where_ids("proposals", "id,batch_id,subject,kind,field,value,evidence,"
        "input_hash,model_revision,prompt_version,created,version", "subject", selected)
    # A moved photo's provenance remains on the donor proposal. Include earlier
    # incoming assignments too, even if that photo was subsequently moved again.
    incoming = snapshot.rows(
        "SELECT DISTINCT d.id,d.proposal_id,d.task_key,d.annotation_id,d.annotation_hash,"
        "d.status,d.value,d.reviewer,d.created FROM decisions d JOIN proposals p ON p.id=d.proposal_id "
        "JOIN json_each(CASE WHEN json_valid(d.value) AND json_type(d.value)='array' "
        "THEN d.value ELSE '[]' END) item WHERE p.kind='group' "
        f"AND json_extract(item.value,'$.target') IN ({_placeholders(selected)})", selected)
    incoming_ids = {r["proposal_id"] for r in incoming}
    proposals.extend(snapshot.where_ids("proposals", "id,batch_id,subject,kind,field,value,evidence,"
        "input_hash,model_revision,prompt_version,created,version", "id", incoming_ids))
    proposals = _unique(proposals, lambda row: row["id"])
    decisions = snapshot.where_ids("decisions", "id,proposal_id,task_key,annotation_id,annotation_hash,"
        "status,value,reviewer,created", "proposal_id", [r["id"] for r in proposals])
    return proposals, decisions


def _split_target(proposal, item):
    return "object-" + uuid.uuid5(uuid.NAMESPACE_URL, canonical([
        proposal["batch_id"], proposal["subject"], "human-split",
        item.get("split_label") or item["asset_id"]]).decode()).hex


def _object_alias_history(snapshot, selected):
    if "object_alias_events" not in snapshot.tables:
        return []
    frontier, visited, events = set(selected), set(), []
    while frontier:
        values = sorted(frontier)
        visited.update(frontier)
        # Preserve both incoming and outgoing identity lineage without collapsing
        # its separate object facts or remote bindings.
        found = snapshot.where_ids("object_alias_events", "id,object_id,target_object_id,decision_id,"
            "revision,scope_hash,created", "object_id", values)
        found.extend(snapshot.where_ids("object_alias_events", "id,object_id,target_object_id,decision_id,"
            "revision,scope_hash,created", "target_object_id", values))
        events.extend(found)
        frontier = {r[key] for r in found for key in ("object_id", "target_object_id")} - visited
    return _unique(events, lambda row: row["id"])


def _asset_identity(snapshot, asset_ids):
    names = {"logical_assets", "asset_aliases", "asset_occurrences"}
    if not names <= snapshot.tables:
        if names & snapshot.tables:
            raise DatasetError("DATASET_IDENTITY_SCHEMA_INCOMPLETE")
        return {"logical_assets": [], "asset_aliases": [], "asset_occurrences": []}
    aliases = snapshot.where_ids("asset_aliases", "asset_id,logical_asset_id", "asset_id", asset_ids)
    _expect_refs(asset_ids, [r["asset_id"] for r in aliases])
    logical_ids = [r["logical_asset_id"] for r in aliases]
    aliases = snapshot.where_ids("asset_aliases", "asset_id,logical_asset_id", "logical_asset_id", logical_ids)
    logical = snapshot.where_ids("logical_assets", "id,sha256", "id", logical_ids)
    _expect_refs(logical_ids, [r["id"] for r in logical])
    occurrences = snapshot.where_ids("asset_occurrences", "id,logical_asset_id,source_asset_id,batch_id,"
        "session_id,sha256,synthetic,created", "logical_asset_id", logical_ids)
    asset_ids.update(r["asset_id"] for r in aliases)
    asset_ids.update(r["source_asset_id"] for r in occurrences)
    asset_ids.update(r["id"] for r in logical)
    return {"logical_assets": logical, "asset_aliases": aliases, "asset_occurrences": occurrences}


def _capture_history(snapshot, occurrences):
    names = {"capture_sessions", "capture_session_revisions", "capture_asset_associations"}
    empty = {name: [] for name in names}
    if not names <= snapshot.tables:
        if names & snapshot.tables:
            raise DatasetError("DATASET_CAPTURE_SCHEMA_INCOMPLETE")
        return empty
    associations = snapshot.where_ids("capture_asset_associations", "id,capture_session_id,occurrence_id,"
        "revision_id,created", "occurrence_id", [r["id"] for r in occurrences])
    ids = [r["capture_session_id"] for r in associations]
    sessions = snapshot.where_ids("capture_sessions", "id,created", "id", ids)
    revisions = snapshot.where_ids("capture_session_revisions", "id,capture_session_id,revision,metadata,"
        "provenance,created", "capture_session_id", ids)
    _expect_refs(ids, [r["id"] for r in sessions])
    _expect_refs([r["revision_id"] for r in associations], [r["id"] for r in revisions])
    revision_sessions = {r["id"]: r["capture_session_id"] for r in revisions}
    if any(revision_sessions[r["revision_id"]] != r["capture_session_id"] for r in associations):
        raise DatasetError("DATASET_CAPTURE_ASSOCIATION_MISMATCH")
    for row in revisions:
        metadata, provenance = _json(row["metadata"]), _json(row["provenance"])
        allowed = {"label", "captured_at", "timezone", "location", "photographer", "device", "notes"}
        if not isinstance(metadata, dict) or not set(metadata) <= allowed or not isinstance(provenance, dict):
            raise DatasetError("DATASET_CAPTURE_METADATA_INVALID")
        row["metadata"] = metadata
        # Imported provenance may name an original path. Preserve its hash, not
        # that free-text source. Actor/kind remain explicit metadata, never auth.
        row["provenance"] = {key: provenance[key] for key in ("kind", "actor") if key in provenance}
        if "source" in provenance:
            row["provenance"]["source_reference_sha256"] = sha(canonical(provenance["source"]))
    return {"capture_sessions": sessions, "capture_session_revisions": revisions,
            "capture_asset_associations": associations}


def _collect(snapshot, selected):
    objects = snapshot.where_ids("objects", "id,batch_id,candidate_key", "id", selected)
    if {row["id"] for row in objects} != set(selected):
        raise DatasetError("DATASET_SELECTED_OBJECT_NOT_FOUND")
    aliases = _object_alias_history(snapshot, selected)
    projection_ids = sorted(set(selected) | {r[key] for r in aliases for key in ("object_id", "target_object_id")})
    proposals, decisions = _selected_history(snapshot, projection_ids)
    facts = snapshot.where_ids("facts", "object_id,field,value,decision_id", "object_id", projection_ids)
    memberships = snapshot.where_ids("object_assets", "object_id,asset_id,role,decision_id", "object_id", projection_ids)
    # Any currently authoritative incoming projection must resolve even when its
    # old decision used a legacy representation that cannot be found by target.
    decisions.extend(snapshot.where_ids("decisions", "id,proposal_id,task_key,annotation_id,annotation_hash,"
        "status,value,reviewer,created", "id", [r["decision_id"] for r in facts + memberships + aliases if r["decision_id"]]))
    decisions = _unique(decisions, lambda row: row["id"])
    proposals.extend(snapshot.where_ids("proposals", "id,batch_id,subject,kind,field,value,evidence,"
        "input_hash,model_revision,prompt_version,created,version", "id", [r["proposal_id"] for r in decisions]))
    proposals = _unique(proposals, lambda row: row["id"])
    seed_assets = {r["asset_id"] for r in memberships}
    for row in proposals:
        evidence_ids = _json(row["evidence"])
        if not isinstance(evidence_ids, list) or any(not isinstance(v, str) for v in evidence_ids):
            raise DatasetError("DATASET_EVIDENCE_INVALID")
        seed_assets.update(evidence_ids)
    if seed_assets:
        # Batch-scoped issue hypotheses remain visible beside the relevant
        # evidence; they are never projected into a reviewed object fact.
        for start in range(0, len(seed_assets), 400):
            part = sorted(seed_assets)[start:start + 400]
            proposals.extend(snapshot.rows(
                "SELECT DISTINCT p.id,p.batch_id,p.subject,p.kind,p.field,p.value,p.evidence,"
                "p.input_hash,p.model_revision,p.prompt_version,p.created,p.version "
                "FROM proposals p JOIN json_each(p.evidence) e WHERE p.kind='issue' "
                f"AND e.value IN ({_placeholders(part)})", part))
        proposals = _unique(proposals, lambda row: row["id"])
    proposal_by_id = {r["id"]: r for r in proposals}
    decision_by_id = {r["id"]: r for r in decisions}
    asset_ids = {r["asset_id"] for r in memberships}
    object_ids = set(selected)
    object_ids.update(r[key] for r in aliases for key in ("object_id", "target_object_id"))
    evidence = []
    for row in proposals:
        row["value"] = _json(row["value"])
        row["evidence"] = _json(row["evidence"])
        if not isinstance(row["evidence"], list) or any(not isinstance(v, str) for v in row["evidence"]):
            raise DatasetError("DATASET_EVIDENCE_INVALID")
        asset_ids.update(row["evidence"])
        evidence.extend({"proposal_id": row["id"], "asset_id": aid} for aid in set(row["evidence"]))
        if row["kind"] != "issue":
            object_ids.add(row["subject"])
        if row["kind"] == "relationship":
            object_ids.add(row["field"])
        elif row["kind"] == "role":
            asset_ids.add(row["field"])
        elif row["kind"] == "group":
            if not isinstance(row["value"], list) or any(not isinstance(v, str) for v in row["value"]):
                raise DatasetError("DATASET_GROUP_PROPOSAL_INVALID")
            asset_ids.update(row["value"])
    for row in decisions:
        if not isinstance(row["reviewer"], str) or not row["reviewer"].strip():
            raise DatasetError("DATASET_REVIEWER_MISSING")
        row["value"] = _json(row["value"])
        proposal = proposal_by_id.get(row["proposal_id"])
        if not proposal:
            raise DatasetError("DATASET_REFERENCE_MISSING")
        if proposal["kind"] == "group" and isinstance(row["value"], list):
            for item in row["value"]:
                if not isinstance(item, dict) or not isinstance(item.get("asset_id"), str):
                    raise DatasetError("DATASET_GROUP_DECISION_INVALID")
                asset_ids.add(item["asset_id"])
                if item.get("target"):
                    object_ids.add(item["target"])
                if item.get("membership") == "split" and row["status"] in ACCEPTED:
                    object_ids.add(_split_target(proposal, item))
    for row in facts + memberships:
        decision = decision_by_id.get(row["decision_id"])
        if not decision or decision["status"] not in ACCEPTED:
            raise DatasetError("DATASET_UNREVIEWED_CURRENT_PROJECTION")
        proposal = proposal_by_id[decision["proposal_id"]]
        if "field" in row:
            row["value"] = _json(row["value"])
            if (proposal["kind"], proposal["subject"], proposal["field"], decision["value"]) != (
                    "field", row["object_id"], row["field"], row["value"]):
                raise DatasetError("DATASET_CURRENT_FACT_MISMATCH")
        elif proposal["kind"] != "group" or not isinstance(decision["value"], list) or not any(
                item.get("asset_id") == row["asset_id"] and item.get("role") == row["role"] and (
                    item.get("membership") == "keep" and proposal["subject"] == row["object_id"] or
                    item.get("membership") == "reassign" and item.get("target") == row["object_id"] or
                    item.get("membership") == "split" and _split_target(proposal, item) == row["object_id"])
                for item in decision["value"] if isinstance(item, dict)):
            raise DatasetError("DATASET_CURRENT_MEMBERSHIP_MISMATCH")
    for row in aliases:
        decision = decision_by_id.get(row["decision_id"])
        if not decision or decision["status"] not in ACCEPTED:
            raise DatasetError("DATASET_UNREVIEWED_OBJECT_ALIAS")
    identity = _asset_identity(snapshot, asset_ids)
    objects = snapshot.where_ids("objects", "id,batch_id,candidate_key", "id", object_ids)
    _expect_refs(object_ids, [r["id"] for r in objects])
    for row in objects:
        row["scope"] = "selected" if row["id"] in selected else "identity_reference" if row["id"] in projection_ids else "provenance_reference"
    presentation = snapshot.where_ids("object_presentation", "object_id,number", "object_id", object_ids)
    assets = snapshot.where_ids("assets", "id,batch_id,sha256,capture,status", "id", asset_ids)
    _expect_refs(asset_ids, [r["id"] for r in assets])
    asset_hashes = {r["id"]: r["sha256"] for r in assets}
    logical_hashes = {r["id"]: r["sha256"] for r in identity["logical_assets"]}
    if any(asset_hashes[r["asset_id"]] != logical_hashes[r["logical_asset_id"]] for r in identity["asset_aliases"]):
        raise DatasetError("DATASET_ASSET_IDENTITY_HASH_MISMATCH")
    if any(r["sha256"] != asset_hashes[r["source_asset_id"]] or
           r["sha256"] != logical_hashes[r["logical_asset_id"]] for r in identity["asset_occurrences"]):
        raise DatasetError("DATASET_ASSET_IDENTITY_HASH_MISMATCH")
    batch_assets = snapshot.where_ids("batch_assets", "batch_id,asset_id", "asset_id", asset_ids)
    batch_ids = {r["batch_id"] for r in objects + assets + proposals + batch_assets}
    batch_ids.update(r["batch_id"] for r in identity["asset_occurrences"])
    batches = snapshot.where_ids("batches", "id,session_id,status,created", "id", batch_ids)
    _expect_refs(batch_ids, [r["id"] for r in batches])
    _expect_refs([r["subject"] for r in proposals if r["kind"] == "issue"], [r["id"] for r in batches])
    session_ids = {r["session_id"] for r in batches + identity["asset_occurrences"]}
    sessions = snapshot.where_ids("sessions", "id,synthetic", "id", session_ids)
    _expect_refs([r["session_id"] for r in batches], [r["id"] for r in sessions])
    session_by_id = {r["id"]: r for r in sessions}
    for row in identity["asset_occurrences"]:
        if row["session_id"] not in session_by_id:
            raise DatasetError("DATASET_REFERENCE_MISSING")
        row["effective_synthetic"] = bool(row["synthetic"] and session_by_id[row["session_id"]]["synthetic"])
    tasks = snapshot.where_ids("tasks", "task_key,task_id,project,kind,version_hash", "task_key", [r["task_key"] for r in decisions])
    _expect_refs([r["task_key"] for r in decisions], [r["task_key"] for r in tasks])
    relationships = snapshot.where_ids("relationships", "proposal_id,value,decision_id", "proposal_id", [r["id"] for r in proposals])
    latest_relationships = {}
    for row in proposals:
        if row["kind"] == "relationship":
            pair = (row["subject"], row["field"])
            previous = latest_relationships.get(pair)
            if previous is None or row["version"] > previous["version"]:
                latest_relationships[pair] = row
    latest_relationship_ids = {row["id"] for row in latest_relationships.values()}
    # The registry retains a row for every reviewed relationship proposal. Only
    # the latest proposal version may supply the current projection; a later
    # pending/rejected/deferred version suppresses the older relationship.
    relationships = [row for row in relationships if row["proposal_id"] in latest_relationship_ids]
    for row in relationships:
        row["value"] = _json(row["value"])
        decision = decision_by_id.get(row["decision_id"])
        if (not decision or decision["status"] not in ACCEPTED or decision["value"] != row["value"] or
                decision["proposal_id"] != row["proposal_id"] or proposal_by_id[row["proposal_id"]]["kind"] != "relationship"):
            raise DatasetError("DATASET_CURRENT_RELATIONSHIP_MISMATCH")
    bindings = []
    for start in range(0, len(object_ids), 100):
        part = sorted(object_ids)[start:start + 100]
        bindings.extend(snapshot.rows("SELECT instance,local_id,kind,server_id FROM bindings WHERE " +
            " OR ".join("(local_id=? OR substr(local_id,1,?)=?)" for _ in part),
            tuple(value for oid in part for value in (oid, len(oid) + 1, oid + ":"))))
    bindings = [row for row in bindings if _binding_in_scope(row, object_ids, asset_ids)]
    records = {"objects": objects, "object_presentation": presentation, "assets": assets,
        "batches": batches, "source_selections": sessions, "batch_assets": batch_assets,
        "proposals": proposals, "evidence": evidence, "review_decisions": decisions,
        "review_tasks": tasks, "current_facts": facts, "current_memberships": memberships,
        "current_relationships": relationships, "bindings": bindings,
        "object_alias_events": aliases, **identity, **_capture_history(snapshot, identity["asset_occurrences"])}
    return records


def read_snapshot(database_path, object_ids, *, max_rows=MAX_ROWS):
    """Return whitelisted metadata, never accessing any source or private config."""
    selected = _ids(object_ids)
    path = Path(database_path)
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
        raise DatasetError("DATASET_DATABASE_UNAVAILABLE")
    if type(max_rows) is not int or not 1 <= max_rows <= MAX_ROWS:
        raise DatasetError("DATASET_ROW_LIMIT_INVALID")
    try:
        connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            snapshot = Snapshot(connection, max_rows)
            records = _collect(snapshot, selected)
            versions = [r["version"] for r in snapshot.rows("SELECT version FROM schema_version ORDER BY version")]
        finally:
            connection.rollback()
            connection.close()
    except sqlite3.Error:
        raise DatasetError("DATASET_SNAPSHOT_INVALID") from None
    return {"selected_object_ids": selected, "registry_schema_versions": versions,
            "records": {name: sorted(rows, key=canonical) for name, rows in records.items()}}


def _write(directory, name, content):
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def _sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def export_dataset(database_path, object_ids, output_root, *, max_rows=MAX_ROWS):
    """Export an explicit snapshot atomically; identical inputs reuse exact bytes.

    The receipt timestamp is intentionally outside the dataset content identity.
    Existing output is verified, never replaced, including on corruption.
    """
    from jsonschema import Draft202012Validator
    snapshot = read_snapshot(database_path, object_ids, max_rows=max_rows)
    schema_bytes = SCHEMA_PATH.read_bytes()
    schema = json.loads(schema_bytes)
    Draft202012Validator.check_schema(schema)
    records = snapshot.pop("records")
    files = {name + ".jsonl": b"".join(canonical(row) + b"\n" for row in rows)
             for name, rows in records.items()}
    files[SCHEMA_PATH.name] = schema_bytes
    identity = {"schema_version": SCHEMA_VERSION, "exporter_version": EXPORTER_VERSION,
        "exporter_sha256": sha(Path(__file__).read_bytes()), "schema_sha256": sha(schema_bytes),
        **snapshot, "scope": "explicit_selection_with_provenance_references", "media_included": False,
        "source_hash_policy": "registry_recorded_not_reverified",
        "eligibility_policy": "current_projection_requires_collected_accepted_or_corrected_decision",
        "files": [{"name": name, "sha256": sha(content), "bytes": len(content),
                   "rows": len(records[name[:-6]]) if name.endswith(".jsonl") else None}
                  for name, content in sorted(files.items())]}
    dataset_id = "dataset-" + sha(canonical(identity))
    manifest = {**identity, "dataset_id": dataset_id}
    if not Draft202012Validator(schema).is_valid({"manifest": manifest, "records": records}):
        raise DatasetError("DATASET_SCHEMA_INVALID")
    files["manifest.json"] = canonical(manifest) + b"\n"
    files["checksums.sha256"] = "".join(f"{sha(content)}  {name}\n"
        for name, content in sorted(files.items())).encode("ascii")
    root = Path(output_root)
    if root.is_symlink():
        raise DatasetError("DATASET_OUTPUT_UNSAFE")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise DatasetError("DATASET_OUTPUT_UNSAFE")
    destination = root / dataset_id

    def verify_existing():
        if not destination.is_dir() or destination.is_symlink():
            raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID")
        if {p.name for p in destination.iterdir()} != set(files) | {"receipt.json"}:
            raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID")
        for name, content in files.items():
            target = destination / name
            if target.is_symlink() or not target.is_file() or target.read_bytes() != content:
                raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID")
        receipt = destination / "receipt.json"
        if receipt.is_symlink() or not receipt.is_file():
            raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID")
        try:
            value = json.loads(receipt.read_bytes())
        except (OSError, ValueError):
            raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID") from None
        if (set(value) != {"dataset_id", "created_at"} or value["dataset_id"] != dataset_id or
                type(value["created_at"]) not in {int, float} or not 0 <= value["created_at"] < 1e12):
            raise DatasetError("DATASET_EXISTING_OUTPUT_INVALID")

    reused = destination.exists()
    if reused:
        verify_existing()
    else:
        lock = root / ("." + dataset_id + ".lock")
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise DatasetError("DATASET_EXPORT_IN_PROGRESS") from None
        temporary = None
        try:
            temporary = Path(tempfile.mkdtemp(prefix=".dataset-pending-", dir=root))
            for name, content in files.items():
                _write(temporary, name, content)
            _write(temporary, "receipt.json", canonical({"dataset_id": dataset_id, "created_at": time.time()}) + b"\n")
            for target in temporary.iterdir():
                target.chmod(0o400)
            _sync_directory(temporary)
            temporary.chmod(0o500)
            if destination.exists():
                verify_existing()
                reused = True
            else:
                os.rename(temporary, destination)
                _sync_directory(root)
        finally:
            if temporary is not None and temporary.exists():
                temporary.chmod(0o700)
                shutil.rmtree(temporary)
            lock.rmdir()
    return {"datasetId": dataset_id, "path": str(destination),
            "manifestSha256": sha(files["manifest.json"]),
            "counts": {name: len(rows) for name, rows in records.items()}, "reused": reused}


def main():
    parser = argparse.ArgumentParser(description="Explicit local metadata-only dataset export; no training or upload")
    parser.add_argument("--database", required=True)
    parser.add_argument("--object", action="append", dest="objects", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(export_dataset(args.database, args.objects, args.output), sort_keys=True))
    except DatasetError as error:
        parser.exit(1, str(error) + "\n")
    except OSError:
        parser.exit(1, "DATASET_IO_FAILED\n")


if __name__ == "__main__":
    main()
