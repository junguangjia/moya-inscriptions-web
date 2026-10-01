#!/usr/bin/env python3
"""One pinned local multi-image VLM process. Source and output stay in private files.

Usage: python model_runner.py --input <private.json> --output <new-private.json>
The caller owns the subprocess deadline. There is no cloud, mock, retry, or fallback.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import resource
import sys
import time
from typing import Any

from proposal_schema import ASSET_ID, ProposalError, build_prompt, ensure, parse_proposal

MODEL_ID = "mlx-community/Qwen3-VL-4B-Instruct-4bit"
MODEL_REVISION = "2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b"
PROMPT_VERSION = "artvenn-evidence-chinese-v3"
WEIGHTS_SHA256 = "90eeb02604181dbcccd0a30a1f550a4a8928ca7dcbee4aee1449239306cfdfca"
WEIGHTS_SIZE = 3093767283
MAX_BATCH = 8
REQUIRED_FILES = {"config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
                  "model.safetensors"}


def private_new(path: Path):
    """Fail if existing, never overwrite another run's evidence."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(fd, "w", encoding="utf-8")


@contextlib.contextmanager
def private_stdio(log):
    """Redirect native-library file descriptors as well as Python streams."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved_out, saved_err = os.dup(1), os.dup(2)
    try:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            yield
        log.flush()
    finally:
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)


def file_digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def validate_request(request: Any) -> tuple[Path, list[dict[str, Any]], int, int]:
    ensure(isinstance(request, dict), "invalid_request")
    ensure(set(request) <= {"model_path", "revision", "batch", "segments", "max_tokens",
                            "segment_timeout_seconds"}, "invalid_request_keys")
    ensure(request.get("revision") == MODEL_REVISION, "model_revision_mismatch")
    ensure(isinstance(request.get("model_path"), str), "invalid_model_path")
    model_path = Path(request["model_path"])
    ensure(model_path.is_absolute() and model_path.is_dir(), "missing_local_model")
    ensure(all((model_path / name).is_file() for name in REQUIRED_FILES), "incomplete_local_model")
    weights = model_path / "model.safetensors"
    ensure(weights.stat().st_size == WEIGHTS_SIZE, "model_weight_size_mismatch")
    ensure(file_digest(weights) == WEIGHTS_SHA256, "model_weight_hash_mismatch")
    config = json.loads((model_path / "config.json").read_text(encoding="utf-8"))
    ensure(config.get("model_type") == "qwen3_vl" and config.get("quantization", {}).get("bits") == 4,
           "model_config_mismatch")
    ensure(("batch" in request) != ("segments" in request), "exactly_one_batch_or_segments_required")
    segments = request.get("segments", [{"segment_id": "batch", "batch": request.get("batch")}])
    ensure(isinstance(segments, list) and 0 < len(segments) <= 64, "invalid_segments")
    seen: set[str] = set()
    seen_segments: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for segment in segments:
        ensure(isinstance(segment, dict) and set(segment) == {"segment_id", "batch"}, "invalid_segment")
        segment_id = segment["segment_id"]
        ensure(isinstance(segment_id, str) and ASSET_ID.fullmatch(segment_id) is not None
               and segment_id not in seen_segments, "invalid_segment_id")
        seen_segments.add(segment_id)
        batch = segment["batch"]
        ensure(isinstance(batch, list) and 0 < len(batch) <= MAX_BATCH, "invalid_batch_size")
        normalized_batch: list[dict[str, str]] = []
        for item in batch:
            ensure(isinstance(item, dict) and set(item) == {"asset_id", "preview_path"}, "invalid_batch_item")
            asset_id = item["asset_id"]
            ensure(isinstance(asset_id, str) and ASSET_ID.fullmatch(asset_id) is not None and asset_id not in seen,
                   "invalid_asset_id")
            seen.add(asset_id)
            ensure(isinstance(item["preview_path"], str), "invalid_preview_path")
            preview = Path(item["preview_path"])
            ensure(preview.is_absolute() and preview.is_file() and not preview.is_symlink(), "missing_local_preview")
            ensure(preview.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}, "invalid_preview_format")
            ensure(0 < preview.stat().st_size <= 20 * 1024 * 1024, "invalid_preview_size")
            normalized_batch.append({"asset_id": asset_id, "preview_path": str(preview)})
        normalized.append({"segment_id": segment_id, "batch": normalized_batch})
    max_tokens = request.get("max_tokens", 4096)
    ensure(type(max_tokens) is int and 512 <= max_tokens <= 6144, "invalid_token_limit")
    timeout = request.get("segment_timeout_seconds", 180)
    ensure(type(timeout) is int and 30 <= timeout <= 600, "invalid_segment_timeout")
    return model_path, normalized, max_tokens, timeout


def checkpoint(path: Path, value: dict[str, Any]) -> None:
    """Atomically replace only this invocation's designated checkpoint file."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    with private_new(temporary) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@contextlib.contextmanager
def segment_deadline(seconds: int):
    # A caller subprocess deadline also covers model load and native GPU stalls.
    def expired(_number, _frame):
        raise TimeoutError("segment_deadline_exceeded")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def run_inference(request: Any, output_path: Path) -> dict[str, Any]:
    for name, value in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                        "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1",
                        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_TOKEN": "",
                        "TOKENIZERS_PARALLELISM": "false"}.items():
        os.environ[name] = value
    model_path, segments, max_tokens, timeout = validate_request(request)
    from PIL import Image
    for segment in segments:
        for item in segment["batch"]:
            with Image.open(item["preview_path"]) as image:
                ensure(image.width <= 1536 and image.height <= 1536, "preview_dimensions_exceeded")
                ensure(image.mode == "RGB", "preview_must_be_rgb")
                image.verify()
    from mlx_vlm import stream_generate, load
    from mlx_vlm.prompt_utils import apply_chat_template

    start = time.monotonic()
    model, processor = load(str(model_path), revision=MODEL_REVISION,
                            trust_remote_code=False, local_files_only=True)
    result: dict[str, Any] = {
        "status": "running", "engine": "mlx-vlm", "model_id": MODEL_ID,
        "revision": MODEL_REVISION, "prompt_version": PROMPT_VERSION,
        "weights_sha256": WEIGHTS_SHA256, "mock": False, "cloud": False,
        "human_review_required": True, "load_seconds": round(time.monotonic() - start, 3),
        "elapsed_seconds": round(time.monotonic() - start, 3), "segments": [],
    }
    checkpoint(output_path, result)
    for segment in segments:
        asset_ids = [item["asset_id"] for item in segment["batch"]]
        images = [item["preview_path"] for item in segment["batch"]]
        segment_start = time.monotonic()
        record: dict[str, Any] = {"segment_id": segment["segment_id"], "status": "failed",
                                  "proposal": None, "error_category": None,
                                  "input_images": len(images), "multi_image_call": len(images) > 1}
        text_parts: list[str] = []
        try:
            with segment_deadline(timeout):
                prompt = apply_chat_template(processor, model.config, build_prompt(asset_ids),
                                             num_images=len(images), enable_thinking=False)
                last_chunk = None
                for chunk in stream_generate(model, processor, prompt, images,
                                             max_tokens=max_tokens, temperature=0.0,
                                             repetition_penalty=1.05):
                    ensure(isinstance(chunk.text, str), "invalid_runtime_response")
                    text_parts.append(chunk.text)
                    ensure(sum(map(len, text_parts)) <= 65536, "invalid_output_length")
                    last_chunk = chunk
                ensure(last_chunk is not None, "empty_runtime_response")
                record["proposal"] = parse_proposal("".join(text_parts), asset_ids)
                record["status"] = "completed"
                record["prompt_tokens"] = int(getattr(last_chunk, "prompt_tokens", 0))
                record["generation_tokens"] = int(getattr(last_chunk, "generation_tokens", 0))
                record["finish_reason"] = str(getattr(last_chunk, "finish_reason", "unknown"))
        except ProposalError as error:
            record["error_category"] = str(error)
        except TimeoutError:
            record["error_category"] = "segment_timeout"
        except Exception:
            import traceback
            traceback.print_exc()
            record["error_category"] = "local_runtime_failure"
        raw_output = output_path.with_name(f"{output_path.name}.{segment['segment_id']}.raw.txt")
        with private_new(raw_output) as handle:
            handle.write("".join(text_parts))
        record["elapsed_seconds"] = round(time.monotonic() - segment_start, 3)
        result["segments"].append(record)
        result["elapsed_seconds"] = round(time.monotonic() - start, 3)
        checkpoint(output_path, result)
    import mlx.core as mx
    result["peak_gpu_memory_gb"] = round(mx.get_peak_memory() / (1024 ** 3), 3)
    result["peak_process_rss_gb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 ** 3), 3)
    completed = sum(segment["status"] == "completed" for segment in result["segments"])
    result["status"] = "completed" if completed == len(segments) else "partial" if completed else "failed"
    checkpoint(output_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    ensure(args.input.is_absolute() and args.output.is_absolute(), "absolute_paths_required")
    ensure(args.input.is_file() and args.input.stat().st_size <= 65536, "invalid_input_file")
    ensure(args.output.parent.is_dir(), "missing_output_directory")
    log_path = args.output.with_name(args.output.name + ".runtime.log")
    ensure(not args.output.exists(), "output_already_exists")
    result: dict[str, Any]
    exit_code = 0
    # Third-party warnings/errors may contain paths or source text: retain privately.
    with private_new(log_path) as log, private_stdio(log):
        try:
            request = json.loads(args.input.read_text(encoding="utf-8"))
            result = run_inference(request, args.output)
            exit_code = 0 if result["status"] == "completed" else 2
        except ProposalError as error:
            result = {"status": "failed", "error_category": str(error), "mock": False,
                      "cloud": False, "segments": []}
            exit_code = 2
        except Exception:
            # Full exception remains in the private runtime log, never in stdout.
            import traceback
            traceback.print_exc(file=log)
            result = {"status": "failed", "error_category": "local_runtime_failure",
                      "mock": False, "cloud": False, "segments": []}
            exit_code = 3
        if exit_code and args.output.exists():
            # Preserve completed segment checkpoints on an unexpected late failure.
            prior = json.loads(args.output.read_text(encoding="utf-8"))
            if prior.get("segments"):
                prior["status"] = "partial" if any(s["status"] == "completed" for s in prior["segments"]) else "failed"
                prior["error_category"] = result.get("error_category", "segment_failed")
                result = prior
    checkpoint(args.output, result)
    print(json.dumps({"status": result["status"], "segments": len(result["segments"]),
                      "completed": sum(s["status"] == "completed" for s in result["segments"])}))
    return exit_code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProposalError as error:
        print(json.dumps({"status": "failed", "error_code": str(error)}))
        raise SystemExit(2)
    except Exception:
        print(json.dumps({"status": "failed", "error_code": "local_io_failure"}))
        raise SystemExit(3)
