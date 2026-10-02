"""Loopback-only Label Studio Community adapter. Never approves publication.

The caller persists mappings BEFORE import and stores normalized human decisions
immutably on collection. Label Studio current annotations are not an edit history.
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "artvenn-label-studio/v1"
KINDS = ("group", "field", "relationship")
ROLES = {"overview", "detail", "label", "context", "unspecified"}
MEMBERSHIP = {"belongs", "remove", "reassign", "split", "unresolved"}
DECISIONS = {"accepted", "corrected", "rejected", "deferred"}
RELATIONSHIPS = {
    "same_physical_object", "different_but_related", "unrelated", "uncertain"
}


class ReviewError(ValueError):
    """Fixed safe category, never raw server responses or annotation text."""


def fingerprint(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def label_config(kind: str) -> str:
    if kind not in KINDS:
        raise ReviewError("REVIEW_KIND_INVALID")
    path = Path(__file__).parent / "templates" / f"{kind}.xml"
    value = path.read_text(encoding="utf-8")
    ET.fromstring(value)
    return value


def make_mapping(*, kind: str, task_key: str, task_version: int,
                 subject_id: str, proposal_ids: list[str], asset_order: list[str],
                 input_hash: str, model_version: str) -> dict[str, Any]:
    value = {
        "schema_version": SCHEMA_VERSION, "review_kind": kind,
        "task_key": task_key, "task_version": task_version,
        "subject_id": subject_id, "proposal_ids": proposal_ids,
        "asset_order": asset_order, "input_hash": input_hash,
        "model_version": model_version,
    }
    validate_mapping(value)
    return value


def validate_mapping(mapping: dict[str, Any]) -> None:
    if mapping.get("schema_version") != SCHEMA_VERSION:
        raise ReviewError("MAPPING_SCHEMA_INVALID")
    if mapping.get("review_kind") not in KINDS:
        raise ReviewError("REVIEW_KIND_INVALID")
    if type(mapping.get("task_version")) is not int or mapping["task_version"] < 1:
        raise ReviewError("TASK_VERSION_INVALID")
    for key in ("task_key", "subject_id", "input_hash", "model_version"):
        if not isinstance(mapping.get(key), str) or not mapping[key].strip():
            raise ReviewError("MAPPING_IDENTITY_MISSING")
    for key in ("asset_order", "proposal_ids"):
        items = mapping.get(key)
        if not isinstance(items, list) or not items:
            raise ReviewError("MAPPING_ORDER_INVALID")
        if any(not isinstance(item, str) or not item.strip() for item in items):
            raise ReviewError("MAPPING_ORDER_INVALID")
        if len(items) != len(set(items)):
            raise ReviewError("MAPPING_ORDER_INVALID")
    if len(mapping["input_hash"]) != 64 or any(char not in "0123456789abcdef" for char in mapping["input_hash"]):
        raise ReviewError("MAPPING_INPUT_HASH_INVALID")


def _image_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if url.startswith("/data/local-files/?d="):
        relative = urllib.parse.parse_qs(parsed.query).get("d", [""])[0]
        if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise ReviewError("PREVIEW_URL_UNSAFE")
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        if parsed.username or parsed.password or parsed.fragment:
            raise ReviewError("PREVIEW_URL_UNSAFE")
        return
    raise ReviewError("PREVIEW_URL_NONLOCAL")


def _base_task(mapping: dict[str, Any], image_urls: list[str], context: str) -> dict[str, Any]:
    validate_mapping(mapping)
    if len(image_urls) != len(mapping["asset_order"]):
        raise ReviewError("ASSET_IMAGE_COUNT_MISMATCH")
    for url in image_urls:
        _image_url(url)
    return {"data": {"images": image_urls, "context": context,
                     "curation": copy.deepcopy(mapping)}, "predictions": []}


def choice_result(name: str, to_name: str, value: str,
                  item_index: int | None = None) -> dict[str, Any]:
    result = {"from_name": name, "to_name": to_name, "type": "choices",
              "value": {"choices": [value]}}
    if item_index is not None:
        result["item_index"] = item_index
    return result


def text_result(name: str, to_name: str, value: str,
                item_index: int | None = None) -> dict[str, Any]:
    result = {"from_name": name, "to_name": to_name, "type": "textarea",
              "value": {"text": [value]}}
    if item_index is not None:
        result["item_index"] = item_index
    return result


def build_group_task(mapping: dict[str, Any], image_urls: list[str],
                     roles: list[str], *, context: str = "AI proposal — human review required",
                     reassign_targets: dict[str, str] | None = None) -> dict[str, Any]:
    task = _base_task(mapping, image_urls, context)
    if mapping["review_kind"] != "group" or len(roles) != len(image_urls):
        raise ReviewError("GROUP_INPUT_INVALID")
    if any(role not in ROLES for role in roles):
        raise ReviewError("ROLE_INVALID")
    targets = dict(reassign_targets or {})
    if any(not label.strip() or not target.strip() for label, target in targets.items()):
        raise ReviewError("REASSIGNMENT_TARGET_INVALID")
    task["data"]["reassign_targets"] = targets
    task["data"]["reassign_choices"] = [{"value": label} for label in targets]
    # Empty dynamic choices are legal but a clear unavailable option avoids blank UI.
    if not targets:
        task["data"]["reassign_choices"] = [{"value": "No other object available — use remove or split"}]
    result = []
    for index, role in enumerate(roles):
        result.extend([choice_result("membership", "images", "belongs", index),
                       choice_result("role", "images", role, index)])
    task["predictions"] = [{"model_version": mapping["model_version"], "result": result}]
    return task


def build_field_task(mapping: dict[str, Any], image_urls: list[str],
                     candidate_value: str, field_path: str,
                     *, context: str = "Evidence assets below; this proposal is unapproved") -> dict[str, Any]:
    task = _base_task(mapping, image_urls, context)
    if mapping["review_kind"] != "field" or len(mapping["proposal_ids"]) != 1:
        raise ReviewError("FIELD_INPUT_INVALID")
    if not isinstance(candidate_value, str) or not candidate_value.strip():
        raise ReviewError("CANDIDATE_VALUE_MISSING")
    task["data"].update({"candidate_value": candidate_value, "field_path": field_path,
                         "candidate_display": f"{field_path}: {candidate_value}"})
    task["predictions"] = [{"model_version": mapping["model_version"],
                            "result": [text_result("field_value", "candidate", candidate_value)]}]
    return task


def build_relationship_task(mapping: dict[str, Any], image_urls: list[str],
                            candidate_relation: str, *, context: str = "Compare these objects; identity is not merged") -> dict[str, Any]:
    task = _base_task(mapping, image_urls, context)
    if mapping["review_kind"] != "relationship" or len(mapping["proposal_ids"]) != 1:
        raise ReviewError("RELATIONSHIP_INPUT_INVALID")
    if candidate_relation not in RELATIONSHIPS:
        raise ReviewError("RELATIONSHIP_INVALID")
    task["data"].update({"candidate_relation": candidate_relation,
                         "candidate_display": f"AI proposal: {candidate_relation}"})
    task["predictions"] = [{"model_version": mapping["model_version"],
                            "result": [choice_result("relationship", "candidate", candidate_relation)]}]
    return task


def verify_task_mapping(task: dict[str, Any], expected: dict[str, Any]) -> None:
    validate_mapping(expected)
    actual = task.get("data", {}).get("curation")
    if actual != expected:
        raise ReviewError("STALE_TASK_MAPPING")
    if len(task.get("data", {}).get("images", [])) != len(expected["asset_order"]):
        raise ReviewError("ASSET_IMAGE_COUNT_MISMATCH")


def validate_annotation(kind: str, task: dict[str, Any], annotation: dict[str, Any],
                        expected_mapping: dict[str, Any]) -> dict[str, Any]:
    """Validate a submitted human annotation against frozen registry metadata.

    This function does not mutate authoritative state. The caller binds the
    completed_by user to a known reviewer and stores the returned content once.
    """
    verify_task_mapping(task, expected_mapping)
    if kind != expected_mapping["review_kind"]:
        raise ReviewError("REVIEW_KIND_MISMATCH")
    if annotation.get("was_cancelled"):
        raise ReviewError("ANNOTATION_CANCELLED")
    if not annotation.get("id") or not annotation.get("completed_by"):
        raise ReviewError("HUMAN_REVIEW_IDENTITY_REQUIRED")
    if annotation.get("task") is not None and annotation["task"] != task.get("id"):
        raise ReviewError("ANNOTATION_TASK_MISMATCH")
    results = annotation.get("result")
    if not isinstance(results, list) or not results:
        raise ReviewError("ANNOTATION_RESULT_MISSING")
    controls = {
        "group": {"membership": ("images", "choices", True),
                  "role": ("images", "choices", True),
                  "reassign_target": ("images", "choices", True),
                  "split_label": ("images", "textarea", True)},
        "field": {"field_value": ("candidate", "textarea", False),
                  "decision": ("candidate", "choices", False),
                  "reason": ("candidate", "textarea", False)},
        "relationship": {"relationship": ("candidate", "choices", False),
                         "decision": ("candidate", "choices", False),
                         "reason": ("candidate", "textarea", False)},
    }[kind]
    values: dict[tuple[str, int | None], str] = {}
    regions = []
    count = len(expected_mapping["asset_order"])
    for result in results:
        if not isinstance(result, dict) or not isinstance(result.get("value"), dict):
            raise ReviewError("CONTROL_RESULT_INVALID")
        name = result.get("from_name")
        index = result.get("item_index")
        if name == "regions":
            if result.get("to_name") != "images" or result.get("type") != "rectanglelabels":
                raise ReviewError("REGION_TAG_MISMATCH")
            if type(index) is not int or not 0 <= index < count:
                raise ReviewError("ITEM_INDEX_INVALID")
            value = result.get("value", {})
            if value.get("rectanglelabels") != ["evidence"]:
                raise ReviewError("REGION_LABEL_INVALID")
            for coordinate in ("x", "y", "width", "height"):
                if type(value.get(coordinate)) not in (float, int) or not 0 <= value[coordinate] <= 100:
                    raise ReviewError("REGION_COORDINATE_INVALID")
            if value["x"] + value["width"] > 100.00001 or value["y"] + value["height"] > 100.00001:
                raise ReviewError("REGION_COORDINATE_INVALID")
            regions.append({"asset_id": expected_mapping["asset_order"][index],
                            "raw": copy.deepcopy(result)})
            continue
        if not isinstance(name, str) or name not in controls:
            raise ReviewError("CONTROL_TAG_UNKNOWN")
        to_name, result_type, per_item = controls[name]
        if result.get("to_name") != to_name or result.get("type") != result_type:
            raise ReviewError("CONTROL_TAG_MISMATCH")
        if per_item:
            if type(index) is not int or not 0 <= index < count:
                raise ReviewError("ITEM_INDEX_INVALID")
        elif index is not None:
            raise ReviewError("UNEXPECTED_ITEM_INDEX")
        key = (name, index)
        if key in values:
            raise ReviewError("DUPLICATE_CONTROL_RESULT")
        content = result.get("value", {}).get("choices" if result_type == "choices" else "text")
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], str):
            raise ReviewError("CONTROL_VALUE_INVALID")
        values[key] = content[0]
    common = {"task_key": expected_mapping["task_key"],
              "task_version": expected_mapping["task_version"],
              "proposal_ids": copy.deepcopy(expected_mapping["proposal_ids"]),
              "subject_id": expected_mapping["subject_id"],
              "annotation_id": annotation["id"], "completed_by": annotation["completed_by"],
              "annotation_created_at": annotation.get("created_at"),
              "annotation_updated_at": annotation.get("updated_at"),
              "raw_regions": regions, "raw_result_hash": fingerprint(results)}
    if kind == "group":
        assets = []
        for index, asset_id in enumerate(expected_mapping["asset_order"]):
            membership = values.get(("membership", index))
            role = values.get(("role", index))
            if membership not in MEMBERSHIP or role not in ROLES:
                raise ReviewError("GROUP_REVIEW_INCOMPLETE")
            target = values.get(("reassign_target", index))
            target_id = None
            split_label = values.get(("split_label", index))
            if membership == "reassign":
                target_id = task["data"].get("reassign_targets", {}).get(target)
                if not target_id or target_id == expected_mapping["subject_id"]:
                    raise ReviewError("REASSIGNMENT_TARGET_REQUIRED")
            if membership == "split" and (not split_label or not split_label.strip()):
                raise ReviewError("SPLIT_LABEL_REQUIRED")
            assets.append({"asset_id": asset_id, "membership": membership, "role": role,
                           "target_object_id": target_id,
                           "split_label": split_label if membership == "split" else None})
        return common | {"kind": kind, "assets": assets}
    decision = values.get(("decision", None))
    if decision not in DECISIONS:
        raise ReviewError("HUMAN_DECISION_REQUIRED")
    proposed = task["data"]["candidate_value" if kind == "field" else "candidate_relation"]
    actual = values.get(("field_value" if kind == "field" else "relationship", None))
    if decision in {"accepted", "corrected"}:
        if not actual or not actual.strip():
            raise ReviewError("REVIEW_VALUE_REQUIRED")
        if kind == "relationship" and actual not in RELATIONSHIPS:
            raise ReviewError("RELATIONSHIP_INVALID")
        if decision == "accepted" and actual != proposed:
            raise ReviewError("ACCEPTED_VALUE_CHANGED")
        if decision == "corrected" and actual == proposed:
            raise ReviewError("CORRECTION_UNCHANGED")
    return common | {"kind": kind, "decision": decision,
                     "value": actual if decision in {"accepted", "corrected"} else None,
                     "reason": values.get(("reason", None)),
                     "field_path": task["data"].get("field_path"),
                     "evidence_asset_ids": copy.deepcopy(expected_mapping["asset_order"])}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReviewError("LABEL_STUDIO_REDIRECT_REFUSED")


class LabelStudioClient:
    """Bounded standard-library HTTP client; no network retry on uncertain writes."""

    def __init__(self, base_url: str, api_key: str, *, auth_scheme: str = "Token",
                 timeout: float = 15, max_pages: int = 100, deadline: float | None = None):
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}):
            raise ReviewError("LABEL_STUDIO_NONLOCAL_REFUSED")
        if not api_key or "\n" in api_key or auth_scheme not in {"Token", "Bearer"}:
            raise ReviewError("LABEL_STUDIO_AUTH_INVALID")
        self.base_url = base_url.rstrip("/")
        self._authorization = f"{auth_scheme} {api_key}"
        self.timeout = timeout
        self.max_pages = max_pages
        self.deadline = deadline
        self._opener = urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if not path.startswith("/api/") or path.startswith("//"):
            raise ReviewError("LABEL_STUDIO_PATH_INVALID")
        timeout = self.timeout
        if self.deadline is not None:
            timeout = min(timeout, self.deadline - time.monotonic())
            if timeout <= 0:
                raise ReviewError("LABEL_STUDIO_DEADLINE")
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=payload, method=method,
                                         headers={"Authorization": self._authorization,
                                                  "Content-Type": "application/json"})
        try:
            with self._opener.open(request, timeout=timeout) as response:
                data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise ReviewError("LABEL_STUDIO_RESPONSE_LIMIT")
                return json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            raise ReviewError(f"LABEL_STUDIO_HTTP_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ReviewError("LABEL_STUDIO_UNREACHABLE") from None
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ReviewError("LABEL_STUDIO_RESPONSE_INVALID") from None

    def _list(self, endpoint: str, result_key: str) -> list[dict[str, Any]]:
        collected = []
        for page in range(1, self.max_pages + 1):
            separator = "&" if "?" in endpoint else "?"
            response = self.request("GET", f"{endpoint}{separator}page={page}&page_size=100")
            if isinstance(response, list):
                collected.extend(response)
                return collected
            if not isinstance(response, dict):
                raise ReviewError("LABEL_STUDIO_RESPONSE_INVALID")
            rows = response.get(result_key, [])
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ReviewError("LABEL_STUDIO_RESPONSE_INVALID")
            collected.extend(rows)
            if response.get("next") is None and ("count" not in response or len(collected) >= response["count"]):
                if "total" not in response or len(collected) >= response["total"]:
                    return collected
            if not rows:
                return collected
        raise ReviewError("LABEL_STUDIO_PAGE_LIMIT")

    def ensure_projects(self, namespace: str = "ArtVenn Curation v1") -> dict[str, int]:
        projects = self._list("/api/projects/", "results")
        output = {}
        for kind in KINDS:
            title = f"{namespace} — {kind}"
            matches = [project for project in projects if project.get("title") == title]
            if len(matches) > 1:
                raise ReviewError("DUPLICATE_REVIEW_PROJECT")
            config = label_config(kind)
            if matches:
                project = self.request("GET", f"/api/projects/{matches[0]['id']}/")
                if ET.tostring(ET.fromstring(project["label_config"])) != ET.tostring(ET.fromstring(config)):
                    raise ReviewError("REVIEW_PROJECT_CONFIG_DRIFT")
            else:
                project = self.request("POST", "/api/projects/", {
                    "title": title, "description": f"{SCHEMA_VERSION}; local human review only; no publication approval",
                    "label_config": config,
                })
            output[kind] = int(project["id"])
        return output

    def list_tasks(self, project_id: int) -> list[dict[str, Any]]:
        return self._list(f"/api/tasks/?project={int(project_id)}&fields=all", "tasks")

    def read_task(self, task_id: int) -> dict[str, Any]:
        return self.request("GET", f"/api/tasks/{int(task_id)}/")

    def import_task(self, project_id: int, task: dict[str, Any]) -> dict[str, Any]:
        mapping = task["data"]["curation"]
        validate_mapping(mapping)
        matches = [item for item in self.list_tasks(project_id)
                   if item.get("data", {}).get("curation", {}).get("task_key") == mapping["task_key"]
                   and item.get("data", {}).get("curation", {}).get("task_version") == mapping["task_version"]]
        if len(matches) > 1:
            raise ReviewError("DUPLICATE_REVIEW_TASK")
        replayed=bool(matches)
        if matches:
            found = self.read_task(matches[0]["id"])
        else:
            response = self.request("POST", f"/api/projects/{int(project_id)}/import?return_task_ids=true", [task])
            task_ids = response.get("task_ids")
            if not isinstance(task_ids, list) or len(task_ids) != 1:
                raise ReviewError("LABEL_STUDIO_IMPORT_RECEIPT_INCOMPLETE")
            found = self.read_task(task_ids[0])
        # New import and crash replay share exact data and prediction readback.
        # No existing native task/annotation is repaired or overwritten here.
        verify_task_mapping(found, mapping)
        if found["data"] != task["data"] or not found.get("predictions"):
            raise ReviewError("LABEL_STUDIO_IMPORT_READBACK_MISMATCH")
        expected_prediction = task["predictions"][0]
        prediction = next((item for item in found["predictions"]
                           if item.get("model_version") == expected_prediction["model_version"]), None)
        fields = ("from_name", "to_name", "type", "item_index", "value")
        signature = lambda items: [{key: item[key] for key in fields if key in item} for item in items]
        if prediction is None or signature(prediction.get("result", [])) != signature(expected_prediction["result"]):
            raise ReviewError("LABEL_STUDIO_PREDICTION_READBACK_MISMATCH")
        return {"id": found["id"], "replayed": replayed, "task": found}
