"""Task-owned photo registry. Research review semantics; never a Catalog master."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

VERSION = 1
PREVIEW_VERSION = "exif-transpose-rgb-jpeg-1536-v1"
ROLES = {"overview", "detail", "label", "context", "unspecified"}
RELATIONS = {"same_physical_object", "different_but_related", "unrelated", "uncertain"}
FIELDS = {"title", "persons", "period_original", "object_form"}


class CurationError(Exception):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical(value).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def stable_id(kind, *values):
    return f"{kind}-{uuid.uuid5(uuid.NAMESPACE_URL, canonical(values)).hex}"


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(canonical(value))
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


def safe_source(root, path):
    root, path = Path(root), Path(path)
    if root.is_symlink() or path.is_symlink():
        raise CurationError("SYMLINK_REFUSED")
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (ValueError, OSError):
        raise CurationError("SOURCE_UNAVAILABLE_OR_OUTSIDE_SELECTION") from None
    for parent in (() if path == root else path.parents):
        if parent == root:
            break
        if parent.is_symlink():
            raise CurationError("SYMLINK_REFUSED")
    return path


def validate_proposal(value, asset_ids):
    if not isinstance(value, dict) or set(value) != {"groups", "roles", "relationships", "issues"}:
        raise CurationError("MODEL_STRUCTURE_INVALID")
    if any(not isinstance(value[k], list) for k in value):
        raise CurationError("MODEL_STRUCTURE_INVALID")
    known = set(asset_ids)
    def evidence(ids):
        if not isinstance(ids, list) or not ids or not set(ids) <= known:
            raise CurationError("EVIDENCE_MISSING_OR_UNKNOWN")
    groups = set()
    for group in value["groups"]:
        if not isinstance(group, dict) or not isinstance(group.get("key"), str) or group["key"] in groups:
            raise CurationError("GROUP_INVALID")
        groups.add(group["key"])
        evidence(group.get("asset_ids"))
        for field in group.get("fields", []):
            if field.get("field") not in FIELDS or not isinstance(field.get("value"), str) or len(field["value"]) > 4000:
                raise CurationError("FIELD_INVALID")
            evidence(field.get("evidence"))
    for role in value["roles"]:
        if role.get("asset_id") not in known or role.get("role") not in ROLES:
            raise CurationError("ROLE_INVALID")
        evidence(role.get("evidence"))
    for relation in value["relationships"]:
        if relation.get("left") not in groups or relation.get("right") not in groups or relation.get("relation") not in RELATIONS:
            raise CurationError("RELATIONSHIP_INVALID")
        evidence(relation.get("evidence"))
    for issue in value["issues"]:
        if not isinstance(issue.get("kind"), str) or not isinstance(issue.get("message"), str):
            raise CurationError("ISSUE_INVALID")
        evidence(issue.get("asset_ids"))
    return value


class Registry:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ("state", "served-previews", "derivatives", "receipts", "logs", "config"):
            (self.root / name).mkdir(exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / "state" / "curation.sqlite", timeout=15)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
        INSERT OR IGNORE INTO schema_version VALUES(1);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, source_root TEXT NOT NULL, synthetic INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), status TEXT NOT NULL, error TEXT, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), relative_path TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, preview TEXT, capture TEXT, status TEXT NOT NULL, error TEXT, UNIQUE(batch_id,relative_path,sha256));
        CREATE TABLE IF NOT EXISTS batch_assets(batch_id TEXT REFERENCES batches(id),asset_id TEXT REFERENCES assets(id),PRIMARY KEY(batch_id,asset_id));
        INSERT OR IGNORE INTO batch_assets SELECT batch_id,id FROM assets;
        CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), candidate_key TEXT NOT NULL, UNIQUE(batch_id,candidate_key));
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), subject TEXT NOT NULL, kind TEXT NOT NULL, field TEXT, value TEXT NOT NULL, evidence TEXT NOT NULL, input_hash TEXT NOT NULL, model_revision TEXT NOT NULL, prompt_version TEXT NOT NULL, created REAL NOT NULL, version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS tasks(task_key TEXT PRIMARY KEY, task_id INTEGER UNIQUE NOT NULL, project INTEGER NOT NULL, kind TEXT NOT NULL, mapping TEXT NOT NULL, version_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id), task_key TEXT REFERENCES tasks(task_key), annotation_id INTEGER NOT NULL, annotation_hash TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, reviewer TEXT NOT NULL, created REAL NOT NULL, UNIQUE(proposal_id,task_key,annotation_id,annotation_hash));
        CREATE TABLE IF NOT EXISTS object_assets(object_id TEXT REFERENCES objects(id),asset_id TEXT REFERENCES assets(id),role TEXT NOT NULL DEFAULT 'unspecified',decision_id TEXT REFERENCES decisions(id),PRIMARY KEY(object_id,asset_id));
        CREATE TABLE IF NOT EXISTS facts(object_id TEXT REFERENCES objects(id),field TEXT NOT NULL,value TEXT NOT NULL,decision_id TEXT REFERENCES decisions(id),PRIMARY KEY(object_id,field));
        CREATE TABLE IF NOT EXISTS relationships(proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),value TEXT NOT NULL,decision_id TEXT REFERENCES decisions(id));
        CREATE TABLE IF NOT EXISTS bindings(instance TEXT NOT NULL,local_id TEXT NOT NULL,kind TEXT NOT NULL,server_id TEXT NOT NULL,PRIMARY KEY(instance,local_id,kind));
        CREATE TRIGGER IF NOT EXISTS immutable_decision_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DECISION'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_decision_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DECISION'); END;
        ''')
        migration = (Path(__file__).parent / "migrations/002-object-presentation.sql").read_text()
        self.db.executescript("BEGIN IMMEDIATE;\n" + migration + "\nCOMMIT;")
        os.chmod(self.root / "state" / "curation.sqlite", 0o600)

    def rows(self, sql, args=()):
        return [dict(row) for row in self.db.execute(sql, args)]

    def status(self):
        return {"exact_duplicate_groups":self.rows("SELECT sha256,count(*) AS files FROM assets GROUP BY sha256 HAVING count(*)>1"),"asset_failures": self.rows("SELECT filename,error FROM assets WHERE status='failed'"),"decoded_assets":self.db.execute("SELECT count(*) FROM assets WHERE status='ready'").fetchone()[0],"batches": self.rows("SELECT id,status,error FROM batches ORDER BY created DESC"), "assets": self.db.execute("SELECT count(*) FROM assets").fetchone()[0], "proposals": self.db.execute("SELECT count(*) FROM proposals").fetchone()[0], "decisions": self.db.execute("SELECT count(*) FROM decisions").fetchone()[0], "objects": self.db.execute("SELECT count(*) FROM objects").fetchone()[0]}

    def inspect(self, source, limit=50, synthetic=False):
        from PIL import Image, ImageOps
        from raw_decoder import RAW_EXTENSIONS, RAW_PREVIEW_VERSION, preview as raw_preview
        source = Path(source).absolute()
        if source in (Path("/"), Path.home(), Path("/Volumes"), Path("/Users")) or not source.is_dir():
            raise CurationError("EXPLICIT_BATCH_DIRECTORY_REQUIRED")
        safe_source(source, source)
        session = stable_id("session", str(source))
        paths = []
        # The selected root is the sole capability. Never follow directory links.
        for directory, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not Path(directory, d).is_symlink() and not d.startswith("."))
            for name in sorted(files):
                path = Path(directory, name)
                if name.startswith(".") or path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".dng", ".cr2", ".nef", ".arw"}:
                    continue
                safe_source(source, path)
                paths.append(path)
                if len(paths) > limit:
                    raise CurationError("BATCH_EXCEEDS_SELECTED_LIMIT")
        if len(paths) > limit:
            raise CurationError("BATCH_EXCEEDS_SELECTED_LIMIT")
        paths = [(p, file_hash(p)) for p in paths]
        if not paths:
            raise CurationError("NO_SUPPORTED_CANDIDATE_FILES")
        batch = stable_id("batch", session, [(str(p.relative_to(source)), h) for p, h in paths])
        # A non-synthetic re-selection can only downgrade the session. It must
        # never retain an earlier test label or promote unknown historical bytes.
        with self.db:
            if not synthetic:self.db.execute('UPDATE sessions SET synthetic=0 WHERE id=?',(session,))
        known=self.db.execute('SELECT 1 FROM batches WHERE id=?',(batch,)).fetchone()
        analyzed=self.db.execute('SELECT 1 FROM objects o JOIN batches b ON b.id=o.batch_id WHERE b.session_id=? LIMIT 1',(session,)).fetchone()
        if analyzed and not known:raise CurationError('ANALYZED_FOLDER_CONTENTS_CHANGED')
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO sessions VALUES(?,?,?)", (session, str(source), int(synthetic)))
            self.db.execute("INSERT OR IGNORE INTO batches VALUES(?,?,?,NULL,?)", (batch, session, "inspected", time.time()))
        for path, sha in paths:
            rel = str(path.relative_to(source))
            asset = stable_id("asset", session, rel, sha)
            previous=self.db.execute("SELECT * FROM assets WHERE id=?", (asset,)).fetchone()
            if previous:
                with self.db:self.db.execute("INSERT OR IGNORE INTO batch_assets VALUES(?,?)", (batch,asset))
                if previous['status']=='ready':continue
                # Keep the failed attempt before retrying the same logical asset.
                private_json(self.root/'state'/f"{asset}-decode-failure-{uuid.uuid4().hex}.json",dict(previous))
            processing_version=RAW_PREVIEW_VERSION if path.suffix.lower() in RAW_EXTENSIONS else PREVIEW_VERSION
            preview = f"photos/{asset}-{processing_version}.jpg"
            (self.root / "served-previews" / "photos").mkdir(exist_ok=True, mode=0o700)
            status, error, capture = "ready", None, None
            try:
                if path.suffix.lower() in RAW_EXTENSIONS:
                    processing=raw_preview(path,self.root/'served-previews'/preview,source,self.root/'state',sha)
                    orientation=None
                else:
                    with Image.open(path) as original:
                        if original.width * original.height > 80_000_000:
                            raise CurationError("IMAGE_PIXEL_BOUND_EXCEEDED")
                        capture = original.getexif().get(36867)
                        orientation = original.getexif().get(274, 1)
                        image = ImageOps.exif_transpose(original).convert("RGB")
                        image.thumbnail((1536, 1536))
                        image.save(self.root / "served-previews" / preview, "JPEG", quality=92)
                        processing={'version':PREVIEW_VERSION,'decoder':'Pillow','exif_orientation':orientation}
                if file_hash(path) != sha:
                    raise CurationError("SOURCE_CHANGED_DURING_PREPARATION")
                private_json(self.root / "state" / f"{asset}-preview.json", {"asset_id":asset,"source_sha256":sha,"preview_sha256":file_hash(self.root / "served-previews" / preview),"version":processing_version,"exif_orientation":orientation,"processing":processing})
            except Exception as exc:
                preview, status = None, "failed"
                error = str(exc) if isinstance(exc, CurationError) else "UNSUPPORTED_OR_CORRUPT_MEDIA"
            with self.db:
                if previous:self.db.execute("UPDATE assets SET preview=?,capture=?,status=?,error=? WHERE id=?",(preview,str(capture) if capture else None,status,error,asset))
                else:self.db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)", (asset,batch,rel,path.name,sha,preview,str(capture) if capture else None,status,error))
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO batch_assets SELECT batch_id,id FROM assets WHERE batch_id=?",(batch,))
        return batch

    def source_verify(self, batch):
        rows = self.rows("SELECT a.*,s.source_root FROM assets a JOIN batches b ON b.id=a.batch_id JOIN sessions s ON s.id=b.session_id WHERE a.id IN (SELECT asset_id FROM batch_assets WHERE batch_id=?)", (batch,))
        for row in rows:
            path = safe_source(row["source_root"], Path(row["source_root"]) / row["relative_path"])
            if file_hash(path) != row["sha256"]:
                raise CurationError("SOURCE_HASH_CHANGED")
        return len(rows)

    def ingest_model(self, batch, segment, value, revision, prompt_version):
        assets = [r["id"] for r in self.rows("SELECT id FROM assets WHERE id IN (SELECT asset_id FROM batch_assets WHERE batch_id=?) AND status='ready'", (batch,))]
        validate_proposal(value, assets)
        input_hash = digest([(r["id"],r["sha256"]) for r in self.rows("SELECT id,sha256 FROM assets WHERE id IN (SELECT asset_id FROM batch_assets WHERE batch_id=?) ORDER BY id",(batch,))])
        objects = {}
        with self.db:
            for group in value["groups"]:
                key = f"{segment}:{group['key']}"
                obj = stable_id("object", batch, key)
                objects[group["key"]] = obj
                self.db.execute("INSERT OR IGNORE INTO objects VALUES(?,?,?)", (obj,batch,key))
                self.propose(batch,obj,"group",None,group["asset_ids"],group["asset_ids"],input_hash,revision,prompt_version)
                for field in group.get("fields",[]):
                    self.propose(batch,obj,"field",field["field"],field["value"],field["evidence"],input_hash,revision,prompt_version)
            for role in value["roles"]:
                # One asset may have a role on each proposed object link.
                for group in value["groups"]:
                    if role["asset_id"] in group["asset_ids"]:
                        self.propose(batch,objects[group["key"]],"role",role["asset_id"],role["role"],role["evidence"],input_hash,revision,prompt_version)
            for relation in value["relationships"]:
                self.propose(batch,objects[relation["left"]],"relationship",objects[relation["right"]],relation["relation"],relation["evidence"],input_hash,revision,prompt_version)
            for issue in value["issues"]:
                self.propose(batch,batch,"issue",issue["kind"],issue["message"],issue["asset_ids"],input_hash,revision,prompt_version)

    def propose(self,batch,subject,kind,field,value,evidence,input_hash,revision,prompt):
        pid = stable_id("proposal",batch,subject,kind,field,value,input_hash,revision,prompt)
        if self.db.execute("SELECT 1 FROM proposals WHERE id=?",(pid,)).fetchone():return pid
        version=self.db.execute("SELECT coalesce(max(version),0)+1 FROM proposals WHERE subject=? AND kind=? AND field IS ?",(subject,kind,field)).fetchone()[0]
        self.db.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(pid,batch,subject,kind,field,canonical(value),canonical(evidence),input_hash,revision,prompt,time.time(),version))
        return pid

    def bind(self,instance,local_id,kind):
        row = self.db.execute("SELECT server_id FROM bindings WHERE instance=? AND local_id=? AND kind=?",(instance,local_id,kind)).fetchone()
        if row:
            return row[0]
        value = stable_id(kind,instance,local_id)
        with self.db:
            self.db.execute("INSERT INTO bindings VALUES(?,?,?,?)",(instance,local_id,kind,value))
        return value

    def decision(self,task,annotation,proposal_id,status,value,reviewer,apply=True):
        if status not in {"accepted","corrected","rejected","deferred"} or not reviewer:
            raise CurationError("EXPLICIT_REVIEW_REQUIRED")
        proposal = self.db.execute("SELECT * FROM proposals WHERE id=?",(proposal_id,)).fetchone()
        if not proposal:
            raise CurationError("STALE_PROPOSAL")
        # created_ago is a volatile display string from Label Studio, not a review edit.
        semantic = {k:v for k,v in annotation.items() if k != 'created_ago'}
        annotation_hash=digest(semantic)
        prior=self.db.execute("SELECT annotation_hash FROM decisions WHERE task_key=? AND annotation_id=? AND proposal_id=?",(task['task_key'],annotation['id'],proposal_id)).fetchone()
        if prior:
            same = prior[0] == annotation_hash
            if not same:
                # Preserve pre-fix immutable decisions; compare their exact frozen snapshot.
                frozen=self.root/'state'/f"{task['task_key']}-{annotation['id']}-{prior[0]}-annotation.json"
                if frozen.exists():
                    old=json.loads(frozen.read_text())['annotation']
                    same=digest({k:v for k,v in old.items() if k != 'created_ago'}) == annotation_hash
            if not same:
                raise CurationError("SYNCED_ANNOTATION_CHANGED_CREATE_NEW_TASK_VERSION")
            return False
        if self.db.execute("SELECT 1 FROM decisions WHERE task_key=? AND proposal_id=?",(task['task_key'],proposal_id)).fetchone():
            raise CurationError('REVIEW_ALREADY_SYNCED_CREATE_NEW_TASK_VERSION')
        latest=self.db.execute("SELECT max(version) FROM proposals WHERE subject=? AND kind=? AND field IS ?",(proposal['subject'],proposal['kind'],proposal['field'])).fetchone()[0]
        if proposal['version'] != latest:
            raise CurationError('STALE_REVIEW_VERSION')
        did=stable_id("decision",proposal_id,task['task_key'],annotation['id'],annotation_hash)
        with self.db:
            self.db.execute("INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?)",(did,proposal_id,task['task_key'],annotation['id'],annotation_hash,status,canonical(value),reviewer,time.time()))
            if apply and status in {"rejected","deferred"} and proposal['kind']=="field":
                self.db.execute("DELETE FROM facts WHERE object_id=? AND field=?",(proposal['subject'],proposal['field']))
            if apply and status in {"accepted","corrected"}:
                if proposal['kind']=="field":
                    self.db.execute("INSERT OR REPLACE INTO facts VALUES(?,?,?,?)",(proposal['subject'],proposal['field'],canonical(value),did))
                elif proposal['kind']=="group":
                    for item in value:
                        aid=item['asset_id']
                        if item['membership']=='keep':
                            self.db.execute("INSERT OR REPLACE INTO object_assets VALUES(?,?,?,?)",(proposal['subject'],aid,item['role'],did))
                        elif item['membership'] in {'remove','reassign','split'}:
                            self.db.execute("DELETE FROM object_assets WHERE object_id=? AND asset_id=?",(proposal['subject'],aid))
                            target=item.get('target')
                            if item['membership']=='split':
                                target=stable_id('object',proposal['batch_id'],proposal['subject'], 'human-split',item.get('split_label') or aid)
                                self.db.execute("INSERT OR IGNORE INTO objects VALUES(?,?,?)",(target,proposal['batch_id'],f"human-split:{proposal['subject']}:{item.get('split_label') or aid}"))
                            if target:
                                if not self.db.execute("SELECT 1 FROM objects WHERE id=?",(target,)).fetchone():
                                    raise CurationError('REASSIGN_TARGET_INVALID')
                                self.db.execute("INSERT OR REPLACE INTO object_assets VALUES(?,?,?,?)",(target,aid,item['role'],did))
                elif proposal['kind']=="relationship":
                    self.db.execute("INSERT OR REPLACE INTO relationships VALUES(?,?,?)",(proposal_id,canonical(value),did))
        return True

    def export(self):
        value={"version":VERSION,"source":"local-curation","tables":{name:self.rows(f"SELECT * FROM {name}") for name in ('sessions','batches','batch_assets','assets','objects','object_presentation','proposals','tasks','decisions','object_assets','facts','relationships','bindings')}}
        private_json(self.root/'state'/'curation-export-v1.json',value)
        return value
