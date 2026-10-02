import copy
import unittest
import xml.etree.ElementTree as ET

from ls_client import (
    LabelStudioClient, ReviewError, build_field_task, build_group_task,
    build_relationship_task, choice_result, label_config, make_mapping,
    text_result, validate_annotation,
)


def mapping(kind="group", order=None):
    return make_mapping(kind=kind, task_key=f"synthetic-{kind}-1", task_version=1,
                        subject_id="synthetic-object-a", proposal_ids=["synthetic-proposal-1"],
                        asset_order=order or ["a1", "a2", "a3", "a4"],
                        input_hash="a" * 64, model_version="synthetic-test-model-revision")


def urls(count):
    return [f"/data/local-files/?d=batch/{i}.png" for i in range(count)]


def annotation(result):
    return {"id": 1, "completed_by": 99, "created_at": "2026-09-30T00:00:00Z",
            "updated_at": "2026-09-30T00:00:00Z", "result": result}


class ReviewContractsTest(unittest.TestCase):
    def test_three_native_projects_with_matching_control_names(self):
        for kind in ("group", "field", "relationship"):
            parsed = ET.fromstring(label_config(kind))
            self.assertEqual(parsed.find("Image").attrib["valueList"], "$images")
            self.assertEqual(parsed.find("Image").attrib["name"], "images")
        group = ET.fromstring(label_config("group"))
        for node in group.findall("Choices"):
            self.assertEqual(node.attrib["perItem"], "true")

    def test_group_predictions_map_four_assets_and_remove_mismatch(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview", "detail", "label", "overview"])
        result = copy.deepcopy(task["predictions"][0]["result"])
        result[6]["value"]["choices"] = ["remove"]
        normalized = validate_annotation("group", task, annotation(result), meta)
        self.assertEqual(normalized["assets"][3]["asset_id"], "a4")
        self.assertEqual(normalized["assets"][3]["membership"], "remove")
        self.assertEqual(len(normalized["assets"]), 4)

    def test_group_reassign_uses_human_label_to_frozen_object_mapping(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4,
                                reassign_targets={"陶壶（对象乙）": "synthetic-object-b"})
        result = copy.deepcopy(task["predictions"][0]["result"])
        result[6]["value"]["choices"] = ["reassign"]
        result.append(choice_result("reassign_target", "images", "陶壶（对象乙）", 3))
        normalized = validate_annotation("group", task, annotation(result), meta)
        self.assertEqual(normalized["assets"][3]["target_object_id"], "synthetic-object-b")

    def test_group_split_requires_label_and_unresolved_is_retained(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4)
        result = copy.deepcopy(task["predictions"][0]["result"])
        result[6]["value"]["choices"] = ["split"]
        with self.assertRaisesRegex(ReviewError, "SPLIT_LABEL_REQUIRED"):
            validate_annotation("group", task, annotation(result), meta)
        result.append(text_result("split_label", "images", "陶壶", 3))
        result[4]["value"]["choices"] = ["unresolved"]
        normalized = validate_annotation("group", task, annotation(result), meta)
        self.assertEqual(normalized["assets"][2]["membership"], "unresolved")

    def test_field_correction_keeps_uncertainty_and_evidence(self):
        meta = mapping("field", ["a3"])
        task = build_field_task(meta, urls(1), "张旭", "attribution")
        result = [text_result("field_value", "candidate", "传张旭"),
                  choice_result("decision", "candidate", "corrected")]
        normalized = validate_annotation("field", task, annotation(result), meta)
        self.assertEqual(normalized["value"], "传张旭")
        self.assertEqual(normalized["evidence_asset_ids"], ["a3"])
        self.assertFalse(any(r["from_name"] == "decision" for r in task["predictions"][0]["result"]))

    def test_accept_changed_value_is_rejected(self):
        meta = mapping("field", ["a3"])
        task = build_field_task(meta, urls(1), "传张旭", "attribution")
        result = [text_result("field_value", "candidate", "张旭"),
                  choice_result("decision", "candidate", "accepted")]
        with self.assertRaisesRegex(ReviewError, "ACCEPTED_VALUE_CHANGED"):
            validate_annotation("field", task, annotation(result), meta)

    def test_relationship_deferred_does_not_create_accepted_relationship(self):
        meta = mapping("relationship", ["a1", "a4"])
        task = build_relationship_task(meta, urls(2), "same_physical_object")
        result = [choice_result("relationship", "candidate", "same_physical_object"),
                  choice_result("decision", "candidate", "deferred")]
        normalized = validate_annotation("relationship", task, annotation(result), meta)
        self.assertEqual(normalized["decision"], "deferred")
        self.assertIsNone(normalized["value"])

    def test_stale_version_and_asset_reorder_are_refused(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4)
        for key, value in [("task_version", 2), ("asset_order", ["a4", "a2", "a3", "a1"])]:
            stale = copy.deepcopy(meta)
            stale[key] = value
            with self.assertRaisesRegex(ReviewError, "STALE_TASK_MAPPING"):
                validate_annotation("group", task, annotation(task["predictions"][0]["result"]), stale)

    def test_out_of_range_or_boolean_item_index_is_refused(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4)
        for index in (4, -1, True, None):
            result = copy.deepcopy(task["predictions"][0]["result"])
            result[0]["item_index"] = index
            with self.assertRaisesRegex(ReviewError, "ITEM_INDEX_INVALID"):
                validate_annotation("group", task, annotation(result), meta)

    def test_unknown_tags_and_wrong_result_types_are_refused(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4)
        for key, value, category in [("from_name", "secret_helper", "CONTROL_TAG_UNKNOWN"),
                                     ("to_name", "wrong", "CONTROL_TAG_MISMATCH"),
                                     ("type", "textarea", "CONTROL_TAG_MISMATCH")]:
            result = copy.deepcopy(task["predictions"][0]["result"])
            result[0][key] = value
            with self.assertRaisesRegex(ReviewError, category):
                validate_annotation("group", task, annotation(result), meta)

    def test_prediction_without_explicit_human_decision_is_not_approved(self):
        meta = mapping("field", ["a3"])
        task = build_field_task(meta, urls(1), "传张旭", "attribution")
        with self.assertRaisesRegex(ReviewError, "HUMAN_DECISION_REQUIRED"):
            validate_annotation("field", task, annotation(task["predictions"][0]["result"]), meta)

    def test_malformed_result_and_hash_have_safe_categories(self):
        meta = mapping()
        task = build_group_task(meta, urls(4), ["overview"] * 4)
        for value in ("bad", {}, {"from_name": "role", "value": []}):
            with self.assertRaisesRegex(ReviewError, "CONTROL_RESULT_INVALID"):
                validate_annotation("group", task, annotation([value]), meta)
        bad = copy.deepcopy(meta)
        bad["input_hash"] = "not-a-hash"
        with self.assertRaisesRegex(ReviewError, "MAPPING_INPUT_HASH_INVALID"):
            build_group_task(bad, urls(4), ["overview"] * 4)

    def test_raw_region_is_preserved_with_asset_identity(self):
        meta = mapping("field", ["a3"])
        task = build_field_task(meta, urls(1), "传张旭", "attribution")
        region = {"id": "test-region", "from_name": "regions", "to_name": "images",
                  "type": "rectanglelabels", "item_index": 0,
                  "value": {"x": 10, "y": 20, "width": 30, "height": 10,
                            "rectanglelabels": ["evidence"]}}
        result = [text_result("field_value", "candidate", "传张旭"),
                  choice_result("decision", "candidate", "accepted"), region]
        normalized = validate_annotation("field", task, annotation(result), meta)
        self.assertEqual(normalized["raw_regions"][0], {"asset_id": "a3", "raw": region})

    def test_nonlocal_images_and_traversal_are_refused(self):
        meta = mapping("field", ["a3"])
        for url in ("https://example.com/image.png", "/data/local-files/?d=../../private.png",
                    "/data/local-files/?d=%2FUsers%2Fprivate.png"):
            with self.assertRaises(ReviewError):
                build_field_task(meta, [url], "传张旭", "attribution")

    def test_http_client_refuses_nonlocal_or_authorizing_base_urls(self):
        for url in ("https://example.com", "http://127.0.0.1:8080?token=placeholder", "http://user:placeholder@127.0.0.1"):
            with self.assertRaisesRegex(ReviewError, "LABEL_STUDIO_NONLOCAL_REFUSED"):
                LabelStudioClient(url, "synthetic-placeholder")


if __name__ == "__main__":
    unittest.main()
