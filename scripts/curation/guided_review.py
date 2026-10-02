"""Scoped human review in the existing local UI, backed by native LS records.

Drafts are private form state. Only an explicit confirmation submits annotations;
Label Studio supplies their identity, and worker.collect creates formal decisions.
"""
import json
import re
import time
import uuid
from pathlib import Path

from registry import CurationError, canonical, digest, private_json
from presentation import card, FIELD_LABELS
from ls_client import choice_result, text_result, validate_annotation, fingerprint, ROLES

FIELDS = ("title", "object_form", "persons", "period_original")


def _path(registry, review_id):
    if not isinstance(review_id, str) or not re.fullmatch(r"[a-f0-9]{32}", review_id):
        raise CurationError("REVIEW_SESSION_INVALID")
    return registry.root / "state" / ("guided-review-" + review_id + ".json")


def read(registry, review_id, material):
    path = _path(registry, review_id)
    if not path.exists():
        raise CurationError("REVIEW_SESSION_UNKNOWN")
    value = json.loads(path.read_text())
    if material != value["material"]:
        raise CurationError("REVIEW_MATERIAL_MISMATCH")
    if material == "synthetic":
        from synthetic_fixture import certified, CERTIFIED_HASHES
        for oid in value["objectIds"]:
            row = registry.db.execute("SELECT s.* FROM objects o JOIN batches b ON b.id=o.batch_id JOIN sessions s ON s.id=b.session_id WHERE o.id=?", (oid,)).fetchone()
            if not row or not row["synthetic"] or not certified(Path(row["source_root"])):
                raise CurationError("SYNTHETIC_PROVENANCE_REQUIRED")
        for aid in value["assetIds"]:
            row = registry.db.execute("SELECT relative_path,sha256 FROM assets WHERE id=?", (aid,)).fetchone()
            if not row or CERTIFIED_HASHES.get(row["relative_path"]) != row["sha256"]:
                raise CurationError("SYNTHETIC_PROVENANCE_REQUIRED")
    return value


def persist(registry, session):
    session["updated"] = time.time()
    private_json(_path(registry, session["id"]), session)


def _latest(registry, oid):
    return registry.rows("""SELECT p.* FROM proposals p WHERE p.subject=? AND p.kind IN ('group','field')
        AND p.version=(SELECT max(q.version) FROM proposals q WHERE q.subject=p.subject AND q.kind=p.kind AND q.field IS p.field)
        ORDER BY p.kind,p.field,p.id""", (oid,))


def snapshot(registry, ids):
    result = []
    for oid in ids:
        obj = card(registry.db, oid)
        proposals = _latest(registry, oid)
        tasks = [t for t in registry.rows("SELECT * FROM tasks ORDER BY task_key")
                 if json.loads(t["mapping"])["subject_id"] == oid]
        result.append({"id": oid, "workingName": obj["workingName"], "assets": [a["id"] for a in obj["assets"]],
                       "proposals": proposals, "tasks": tasks,
                       "links": registry.rows("SELECT * FROM object_assets WHERE object_id=? ORDER BY asset_id", (oid,)),
                       "facts": registry.rows("SELECT * FROM facts WHERE object_id=? ORDER BY field", (oid,)),
                       "decisions": registry.rows("SELECT d.* FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE p.subject=? ORDER BY d.id", (oid,))})
    return digest(result)


def begin(registry, object_ids, material):
    if material not in {"local", "synthetic"} or not 1 <= len(object_ids) <= 12 or len(set(object_ids)) != len(object_ids):
        raise CurationError("REVIEW_SCOPE_INVALID")
    objects = [card(registry.db, oid) for oid in object_ids]
    if any(not o["assets"] or o["synthetic"] != (material == "synthetic") for o in objects):
        raise CurationError("REVIEW_SCOPE_INVALID")
    photos = {}
    for obj in objects:
        for asset in obj["assets"]:
            entry = photos.setdefault(asset["id"], {**asset, "origins": [], "destination": obj["id"]})
            entry["origins"].append(obj["id"])
    if not 1 <= len(photos) <= 64:
        raise CurationError("REVIEW_PHOTO_LIMIT")
    target = objects[0]["id"]
    candidates = []
    for oid in object_ids:
        for p in _latest(registry, oid):
            if p["kind"] == "field":
                candidates.append({"objectId": oid, "field": p["field"], "value": json.loads(p["value"]), "proposalId": p["id"]})
    fields = {}
    facts = {r["field"]: json.loads(r["value"]) for r in registry.rows("SELECT * FROM facts WHERE object_id=?", (target,))}
    for key in FIELDS:
        candidate = next((p["value"] for p in candidates if p["objectId"] == target and p["field"] == key), "")
        fields[key] = {"action": "set" if key in {"title", "object_form"} or candidate else "skip",
                       "value": facts.get(key, candidate), "label": FIELD_LABELS[key]}
    session = {"id": uuid.uuid4().hex, "material": material, "objectIds": list(object_ids), "assetIds": list(photos),
               "objects": [{"id": o["id"], "code": o["code"], "name": o["name"], "photoCount": len(o["assets"])} for o in objects],
               "photos": list(photos.values()), "candidates": candidates, "baseline": snapshot(registry, object_ids),
               "draft": {"targetId": target, "workingName": objects[0]["workingName"], "fields": fields,
                         "photos": [{"assetId": a["id"], "destination": a["destination"], "role": a.get("role", "unspecified")} for a in photos.values()]},
               "revision": 1, "state": "draft", "created": time.time(), "taskKeys": []}
    persist(registry, session)
    # Enforce certified Synthetic scope before recording a reusable entry point.
    read(registry, session["id"], material)
    private_json(registry.root / "state" / ("guided-active-" + material + ".json"), {"id": session["id"]})
    return project(registry, session)


def _validate_draft(session, draft, confirming=False):
    if not isinstance(draft, dict) or draft.get("targetId") not in session["objectIds"]:
        raise CurationError("REVIEW_TARGET_INVALID")
    name = draft.get("workingName", "")
    if not isinstance(name, str) or len(name) > 120 or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in name):
        raise CurationError("WORKING_NAME_INVALID")
    photos = draft.get("photos")
    if not isinstance(photos, list) or len(photos) != len(session["assetIds"]):
        raise CurationError("REVIEW_PHOTO_SCOPE_CHANGED")
    if {a.get("assetId") for a in photos} != set(session["assetIds"]):
        raise CurationError("REVIEW_PHOTO_SCOPE_CHANGED")
    for photo in photos:
        if photo.get("role") not in ROLES or photo.get("destination") not in [*session["objectIds"], "none"]:
            raise CurationError("REVIEW_PHOTO_CHOICE_INVALID")
    if not any(a["destination"] == draft["targetId"] for a in photos):
        raise CurationError("REVIEW_TARGET_EMPTY")
    fields = draft.get("fields")
    if not isinstance(fields, dict) or set(fields) != set(FIELDS):
        raise CurationError("REVIEW_FIELDS_INVALID")
    for key, item in fields.items():
        if not isinstance(item, dict) or item.get("action") not in {"set", "reject", "defer", "skip"}:
            raise CurationError("REVIEW_FIELDS_INVALID")
        value = item.get("value", "")
        if not isinstance(value, str) or len(value) > 4000 or "\x00" in value:
            raise CurationError("REVIEW_FIELD_VALUE_INVALID")
        existing = any(p["objectId"] == draft["targetId"] and p["field"] == key for p in session["candidates"])
        if confirming and item["action"] == "set" and not value.strip():
            raise CurationError("REVIEW_FIELD_VALUE_REQUIRED")
        if confirming and key in {"title", "object_form"} and item["action"] != "set":
            raise CurationError("NECESSARY_FIELDS_REQUIRED")
        if confirming and item["action"] == "skip" and existing:
            raise CurationError("EXISTING_FIELD_DISPOSITION_REQUIRED")
        if confirming and item["action"] in {"reject", "defer"} and not existing:
            raise CurationError("NO_FIELD_PROPOSAL_TO_REVIEW")


def save(registry, session, draft, revision):
    if session["state"] != "draft":
        raise CurationError("CONFIRMED_REVIEW_IMMUTABLE")
    if revision != session["revision"] or snapshot(registry, session["objectIds"]) != session["baseline"]:
        raise CurationError("REVIEW_PREVIEW_STALE")
    _validate_draft(session, draft)
    session["draft"] = draft
    session["revision"] += 1
    persist(registry, session)
    return project(registry, session)


def _signature(results):
    keys = ("from_name", "to_name", "type", "item_index", "value")
    return fingerprint(sorted([{k: r[k] for k in keys if k in r} for r in results], key=canonical))


def _assert_no_pending_native(registry, client, session):
    latest = {p["id"] for oid in session["objectIds"] for p in _latest(registry, oid)}
    for row in registry.rows("SELECT * FROM tasks"):
        mapping = json.loads(row["mapping"])
        if not set(mapping["proposal_ids"]) & latest:
            continue
        task = client.read_task(row["task_id"])
        if fingerprint(task["data"]) != row["version_hash"]:
            raise CurationError("STALE_TASK_CONTENT")
        for annotation in task.get("annotations", []):
            if annotation.get("was_cancelled"):
                continue
            previous = registry.db.execute("SELECT annotation_hash FROM decisions WHERE task_key=? AND annotation_id=?", (row["task_key"], annotation["id"])).fetchone()
            if not previous or previous[0] != digest({k: v for k, v in annotation.items() if k != "created_ago"}):
                raise CurationError("NATIVE_DECISIONS_NEED_COLLECTION")


def _intents(registry, session):
    draft = session["draft"]
    photos = {a["assetId"]: a for a in draft["photos"]}
    intents = []
    for oid in session["objectIds"]:
        ids = [a["id"] for a in session["photos"] if oid in a["origins"]]
        intents.append({"subject": oid, "kind": "group", "field": None, "value": ids, "evidence": ids})
    target_evidence = [a["assetId"] for a in photos.values() if a["destination"] == draft["targetId"]]
    for key, item in draft["fields"].items():
        if item["action"] == "skip":
            continue
        old = next((p["value"] for p in session["candidates"] if p["objectId"] == draft["targetId"] and p["field"] == key), "")
        intents.append({"subject": draft["targetId"], "kind": "field", "field": key,
                        "value": item["value"].strip() if item["action"] == "set" else old,
                        "evidence": target_evidence, "disposition": "accepted" if item["action"] == "set" else "rejected" if item["action"] == "reject" else "deferred"})
    return intents


def _stage(registry, config, session):
    from worker import review_tasks
    input_hash = digest({"baseline": session["baseline"], "draft": session["draft"], "session": session["id"]})
    with registry.db:
        for intent in session["intents"]:
            obj = registry.db.execute("SELECT batch_id FROM objects WHERE id=?", (intent["subject"],)).fetchone()
            intent["proposalId"] = registry.propose(obj["batch_id"], intent["subject"], intent["kind"], intent["field"], intent["value"], intent["evidence"], input_hash, "human-entry/v1", "guided-review/v1")
    persist(registry, session)
    ids = {i["proposalId"] for i in session["intents"]}
    for oid in session["objectIds"]:
        batch = registry.db.execute("SELECT batch_id FROM objects WHERE id=?", (oid,)).fetchone()[0]
        review_tasks(registry, config, batch, proposal_ids=ids)
    tasks = []
    for row in registry.rows("SELECT * FROM tasks ORDER BY task_id"):
        if set(json.loads(row["mapping"])["proposal_ids"]) & ids:
            tasks.append(row["task_key"])
    if len(tasks) != len(ids):
        raise CurationError("REVIEW_TASK_CREATION_INCOMPLETE")
    session["taskKeys"] = tasks
    persist(registry, session)


def _results(session, task, mapping, intent):
    if intent["kind"] == "field":
        results = [choice_result("decision", "candidate", intent["disposition"])]
        if intent["disposition"] == "accepted":
            results.append(text_result("field_value", "candidate", intent["value"]))
        return results
    photos = {p["assetId"]: p for p in session["draft"]["photos"]}
    results = []
    for index, aid in enumerate(mapping["asset_order"]):
        item = photos[aid]
        destination = item["destination"]
        membership = "belongs" if destination == mapping["subject_id"] else "remove" if destination == "none" else "reassign"
        results.extend([choice_result("membership", "images", membership, index), choice_result("role", "images", item["role"], index)])
        if membership == "reassign":
            target = next((label for label, oid in task["data"]["reassign_targets"].items() if oid == destination), None)
            if target is None:
                raise CurationError("REASSIGN_TARGET_INVALID")
            results.append(choice_result("reassign_target", "images", target, index))
    return results


def confirm(registry, config, session, draft, revision, confirmed):
    from worker import ls, collect
    if confirmed is not True:
        raise CurationError("EXPLICIT_REVIEW_CONFIRMATION_REQUIRED")
    client = ls(config)
    if session["state"] == "draft":
        save(registry, session, draft, revision)
        _validate_draft(session, session["draft"], confirming=True)
        _assert_no_pending_native(registry, client, session)
        session["intents"] = _intents(registry, session)
        session["state"] = "submitting"
        session["confirmedAt"] = time.time()
        session["attemptedTasks"] = []
        persist(registry, session)
    elif draft != session["draft"]:
        raise CurationError("CONFIRMED_REVIEW_IMMUTABLE")
    if session["state"] in {"collected", "package_prepared"}:
        return project(registry, session)
    try:
        _stage(registry, config, session)
        intents = {i["proposalId"]: i for i in session["intents"]}
        approved = {}
        for task_key in session["taskKeys"]:
            stored = registry.db.execute("SELECT * FROM tasks WHERE task_key=?", (task_key,)).fetchone()
            mapping = json.loads(stored["mapping"])
            intent = intents[mapping["proposal_ids"][0]]
            latest = registry.db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?", (intent["subject"], intent["kind"], intent["field"])).fetchone()[0]
            if latest != mapping["task_version"]:
                raise CurationError("REVIEW_PREVIEW_STALE")
            task = client.read_task(stored["task_id"])
            if fingerprint(task["data"]) != stored["version_hash"]:
                raise CurationError("STALE_TASK_CONTENT")
            results = _results(session, task, mapping, intent)
            annotations = [a for a in task.get("annotations", []) if not a.get("was_cancelled")]
            if not annotations:
                if task_key in session["attemptedTasks"]:
                    raise CurationError("NATIVE_SUBMISSION_OUTCOME_UNKNOWN")
                session["attemptedTasks"].append(task_key)
                persist(registry, session)
                # No completed_by, ground_truth or invented identity. LS binds request.user.
                client.request("POST", f"/api/tasks/{stored['task_id']}/annotations/", {"result": results, "was_cancelled": False})
                task = client.read_task(stored["task_id"])
                annotations = [a for a in task.get("annotations", []) if not a.get("was_cancelled")]
            if len(annotations) != 1 or _signature(annotations[0].get("result", [])) != _signature(results):
                raise CurationError("NATIVE_SUBMISSION_READBACK_MISMATCH")
            validate_annotation(stored["kind"], task, annotations[0], mapping)
            approved[task_key] = {"id": annotations[0]["id"], "hash": digest({k: v for k, v in annotations[0].items() if k != "created_ago"})}
        session["approvedAnnotations"] = approved
        session["state"] = "submitted_waiting_collection"
        persist(registry, session)
        result = collect(registry, config, task_keys=session["taskKeys"], expected_annotations=approved)
        if result["failures"]:
            session["error"] = result["failures"][0]
            persist(registry, session)
            return project(registry, session)
        if any(not registry.db.execute("SELECT 1 FROM decisions WHERE task_key=? AND annotation_id=? AND annotation_hash=?", (key, value["id"], value["hash"])).fetchone() for key, value in approved.items()):
            raise CurationError("REVIEW_COLLECTION_INCOMPLETE")
        from presentation import rename
        if session["draft"]["workingName"].strip():
            rename(registry.db, session["draft"]["targetId"], session["draft"]["workingName"])
        session["state"] = "collected"
        session.pop("error", None)
        session["collectedAt"] = time.time()
        session["collectedSnapshot"] = snapshot(registry, session["objectIds"])
        persist(registry, session)
    except Exception as exc:
        session["error"] = str(exc) if isinstance(exc, (CurationError, ValueError)) else "GUIDED_REVIEW_SAVE_FAILED"
        persist(registry, session)
    return project(registry, session)


def project(registry, session):
    task_keys = set(session["taskKeys"])
    tasks = [r for r in registry.rows("SELECT * FROM tasks") if r["task_key"] in task_keys]
    from daily import submitted_tasks, missing_reviews
    submitted = submitted_tasks(registry.root, [r["task_id"] for r in tasks])
    collected = sum(bool(registry.db.execute("SELECT 1 FROM decisions WHERE task_key=?", (r["task_key"],)).fetchone()) for r in tasks)
    result = {key: session[key] for key in ("id", "material", "objectIds", "assetIds", "objects", "photos", "candidates", "draft", "revision", "state", "updated")}
    result.update(error=session.get("error"), stale=bool(session.get("collectedSnapshot") and session["collectedSnapshot"] != snapshot(registry, session["objectIds"])), progress={"tasks": len(tasks), "submitted": len(submitted) if submitted is not None else None, "collected": collected},
                  tasks=[{"id": t["task_id"], "kind": t["kind"], "url": "/review?task=" + str(t["task_id"]) + ("&synthetic=1" if session["material"] == "synthetic" else "")} for t in tasks],
                  missing=missing_reviews(registry.db, session["draft"]["targetId"]), package=session.get("package"), packageChoice=session.get("packageChoice"))
    return result


def active(registry, material, allowed_ids):
    file = registry.root / "state" / ("guided-active-" + material + ".json")
    if not file.exists():
        return None
    session = read(registry, json.loads(file.read_text())["id"], material)
    if not set(session["objectIds"]) <= set(allowed_ids):
        return None
    return {"id": session["id"], "photos": len(session["assetIds"]), "state": session["state"],
            "url": "/objects?material=" + material + "&review=" + session["id"]}


def prepare_package(registry, session, choice, confirmed):
    from worker import prepare
    if confirmed is not True or session["state"] not in {"collected", "package_prepared"}:
        raise CurationError("COLLECTED_REVIEW_REQUIRED")
    if session.get("collectedSnapshot") != snapshot(registry, session["objectIds"]):
        raise CurationError("REVIEW_PREVIEW_STALE")
    if choice.get("objectId") != session["draft"]["targetId"]:
        raise CurationError("REVIEW_TARGET_INVALID")
    expected = {a["assetId"] for a in session["draft"]["photos"] if a["destination"] == choice["objectId"]}
    selected = [m.get("assetId") for m in choice.get("media", [])]
    if not selected or len(selected) != len(set(selected)) or not set(selected) <= expected:
        raise CurationError("PUBLIC_MEDIA_SCOPE_INVALID")
    result = prepare(registry, [choice])
    session["package"] = {**result, "savedAt": time.time(), "photoCount": len(selected)}
    session["packageChoice"] = choice
    session["state"] = "package_prepared"
    persist(registry, session)
    return project(registry, session)
