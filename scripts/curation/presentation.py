"""Private object names and read-only projections; never approved public facts."""
import json
from contextlib import contextmanager
import re
import sqlite3
import urllib.parse
from pathlib import Path
from registry import CurationError

NAME_LIMIT = 120
PREVIEW = re.compile(r"photos/[a-zA-Z0-9_.-]+\.jpg\Z")
KIND_LABELS = {"group": "审核照片分组", "field": "审核资料字段", "relationship": "审核对象关系"}
FIELD_LABELS = {"title": "标题", "persons": "人物", "period_original": "年代", "object_form": "对象类型"}


@contextmanager
def readonly(root):
    db = sqlite3.connect((Path(root) / "state/curation.sqlite").resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    try:
        db.execute("BEGIN")
        yield db
    finally:
        db.close()


def rename(db, object_id, name):
    if not isinstance(name, str) or len(name) > NAME_LIMIT or any(ord(c) < 32 or 127 <= ord(c) < 160 for c in name):
        raise CurationError("WORKING_NAME_INVALID")
    with db:
        changed = db.execute("UPDATE object_presentation SET working_name=? WHERE object_id=?", (name.strip(), object_id))
        if changed.rowcount != 1:
            raise CurationError("OBJECT_UNKNOWN")
    return {"status": "working_name_saved", "public_title": "unchanged"}


def assets(db, ids, native=False):
    result = []
    for aid in dict.fromkeys(ids):
        row = db.execute("""SELECT a.id,a.filename,a.preview,s.synthetic FROM assets a JOIN batches b ON b.id=a.batch_id JOIN sessions s ON s.id=b.session_id WHERE a.id=? AND a.status='ready'""", (aid,)).fetchone()
        if row is None or not row["preview"] or not PREVIEW.fullmatch(row["preview"]):
            continue
        url = ("/data/local-files/?d=" + urllib.parse.quote(row["preview"], safe="/")) if native else "/preview/" + row["preview"]
        result.append({"id": row["id"], "filename": row["filename"], "url": url, "synthetic": bool(row["synthetic"])})
    return result


def card(db, object_id, native=False):
    row = db.execute("""SELECT o.id,o.batch_id,p.number,p.working_name,s.synthetic
        FROM objects o JOIN object_presentation p ON p.object_id=o.id
        JOIN batches b ON b.id=o.batch_id JOIN sessions s ON s.id=b.session_id WHERE o.id=?""", (object_id,)).fetchone()
    if row is None:
        raise CurationError("OBJECT_UNKNOWN")
    name, source = row["working_name"], "本地名称"
    if not name:
        fact = db.execute("SELECT value FROM facts WHERE object_id=? AND field='title'", (object_id,)).fetchone()
        name, source = (json.loads(fact["value"]), "已审核标题") if fact else ("", "尚未命名")
    if not name:
        title = db.execute("""SELECT p.value,p.id FROM proposals p WHERE p.subject=? AND p.kind='field'
            AND p.field='title' ORDER BY p.version DESC,p.created DESC LIMIT 1""", (object_id,)).fetchone()
        if title and not db.execute("SELECT 1 FROM decisions WHERE proposal_id=? AND status IN ('rejected','deferred')", (title["id"],)).fetchone():
            name, source = json.loads(title["value"]), "AI 建议名称 · 待确认"
    if not isinstance(name, str) or not name.strip():
        name, source = "尚未命名", "请按照片给它起一个本地名称"
    group = db.execute("SELECT id,value FROM proposals WHERE subject=? AND kind='group' ORDER BY version DESC,created DESC LIMIT 1", (object_id,)).fetchone()
    confirmed = [r["asset_id"] for r in db.execute("SELECT asset_id FROM object_assets WHERE object_id=? ORDER BY rowid", (object_id,))]
    reviewed = bool(confirmed or db.execute("""SELECT 1 FROM decisions d JOIN proposals p ON p.id=d.proposal_id
        WHERE p.subject=? AND p.kind='group' AND d.status IN ('accepted','corrected') LIMIT 1""", (object_id,)).fetchone())
    ids = confirmed if reviewed else list(dict.fromkeys((json.loads(group["value"]) if group else []) + confirmed))
    photos=assets(db,ids,native)
    for photo in photos:
        link=db.execute('SELECT role,decision_id FROM object_assets WHERE object_id=? AND asset_id=?',(object_id,photo['id'])).fetchone()
        proposed=db.execute("SELECT value FROM proposals WHERE subject=? AND kind='role' AND field=? ORDER BY version DESC LIMIT 1",(object_id,photo['id'])).fetchone()
        photo['role']=link['role'] if link else json.loads(proposed['value']) if proposed else 'unspecified'
        photo['roleSource']='人工已保存' if link and link['decision_id'] else 'AI 建议 / 待确认' if proposed else '待确认'
    moved_to=[]
    if reviewed and not photos:
        last=db.execute("SELECT d.value FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE p.subject=? AND p.kind='group' AND d.status IN ('accepted','corrected') ORDER BY p.version DESC,d.created DESC LIMIT 1",(object_id,)).fetchone()
        if last:
            for target in dict.fromkeys(x.get('target') for x in json.loads(last['value']) if x.get('membership')=='reassign'):
                if target:
                    dest=db.execute('SELECT number FROM object_presentation WHERE object_id=?',(target,)).fetchone()
                    if dest:moved_to.append(f"AV-{dest['number']:04d}")
    synthetic=bool(row["synthetic"]) and all(a["synthetic"] for a in photos)
    material_label="SYNTHETIC FIXTURE / 合成测试" if synthetic else "混合来源 · 包含本机选定资料" if row["synthetic"] else "本机选定资料"
    return {"id": row["id"], "code": f"AV-{row['number']:04d}", "name": name, "workingName": row["working_name"],
            "nameSource": source, "synthetic": synthetic, "materialLabel": material_label, "membership": "已收集的人工分组" if reviewed else "AI 候选分组 · 待人工确认",
            "assets": photos,"movedTo":moved_to}


def object_directory(db, material="all"):
    if material not in {"all", "synthetic", "local"}:
        raise CurationError("MATERIAL_FILTER_INVALID")
    cards = [card(db, row["object_id"]) for row in db.execute("SELECT object_id FROM object_presentation ORDER BY number")]
    cards = [c for c in cards if material == "all" or c["synthetic"] == (material == "synthetic")]
    indexed = {c["id"]: c for c in cards}
    for obj in cards:
        obj["tasks"] = []
    for task in db.execute("SELECT * FROM tasks ORDER BY task_id"):
        mapping = json.loads(task["mapping"])
        proposal = db.execute("SELECT * FROM proposals WHERE id=?", (mapping.get("proposal_ids", [""])[0],)).fetchone()
        if not proposal:
            continue
        latest = db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?", (proposal["subject"], proposal["kind"], proposal["field"])).fetchone()[0]
        if proposal["version"] != latest:
            continue
        ids = [proposal["subject"]] + ([proposal["field"]] if task["kind"] == "relationship" else [])
        for oid in ids:
            if oid not in indexed:
                continue
            label = KIND_LABELS[task["kind"]]
            if task["kind"] == "field":
                label += " · " + FIELD_LABELS.get(proposal["field"], proposal["field"])
            status = db.execute("SELECT status FROM decisions WHERE proposal_id=? ORDER BY created DESC LIMIT 1", (proposal["id"],)).fetchone()
            indexed[oid]["tasks"].append({"id": task["task_id"], "label": label, "collected": status["status"] if status else None,
                "url": "/review?task=" + str(task["task_id"])})
    return {"objects": cards, "material": material}


def task_context(root, db, task_id, project, native_data=None):
    task = db.execute("SELECT * FROM tasks WHERE task_id=? AND project=?", (task_id, project)).fetchone()
    if task is None:
        raise CurationError("REVIEW_CONTEXT_UNKNOWN")
    mapping = json.loads(task["mapping"])
    path = Path(root) / "state" / (task["task_key"] + "-task.json")
    data = native_data if native_data is not None else json.loads(path.read_text())["data"]
    # Native data is checked against the exact stored immutable fingerprint.
    # Older import-intent copies may predate a reviewed task's final data.
    from ls_client import fingerprint
    if fingerprint(data) != task["version_hash"] or data.get("curation") != mapping:
        raise CurationError("REVIEW_CONTEXT_STALE")
    current = card(db, mapping["subject_id"], True)
    context = {"task": task_id, "project": project, "kind": task["kind"], "current": current,
               "reviewImages": assets(db, mapping["asset_order"], True), "targets": []}
    if task["kind"] == "group":
        for label, oid in data.get("reassign_targets", {}).items():
            context["targets"].append({"choice": label, "object": card(db, oid, True)})
    elif task["kind"] == "relationship":
        proposal = db.execute("SELECT field FROM proposals WHERE id=?", (mapping["proposal_ids"][0],)).fetchone()
        context["other"] = card(db, proposal["field"], True)
    elif task["kind"] == "field":
        proposal = db.execute("SELECT field FROM proposals WHERE id=?", (mapping["proposal_ids"][0],)).fetchone()
        context["field"] = FIELD_LABELS.get(proposal["field"], proposal["field"])
    return context
