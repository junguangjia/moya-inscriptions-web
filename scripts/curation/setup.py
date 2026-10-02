#!/usr/bin/env python3
"""Reproduce this task's reviewed local dependencies and one public VLM.

No Python, uv, Node or global settings are installed or changed. Existing task
environments are reused only when their complete inventory matches the lock.
Drift or an incomplete installation is preserved and refused without repair.
Installation readiness is separate from actual inference and Draft evidence.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

CODE = Path(__file__).resolve().parent
DEFAULT_ROOT = Path.home() / "Developer/artifacts/moya-inscriptions-web/ai-curation-v1/runtime"
PINNED_MODEL = {
    "model_id": "mlx-community/Qwen3-VL-4B-Instruct-4bit",
    "model_revision": "2fd8dacbdb8f1e54b8c005f081ec5bf79c56376b",
    "weights_file": "model.safetensors",
    "weights_size_bytes": 3093767283,
    "weights_sha256": "90eeb02604181dbcccd0a30a1f550a4a8928ca7dcbee4aee1449239306cfdfca",
}
MODEL_DIRECTORY = "qwen3-vl-4b"
MODEL_FILES = [
    "config.json", "tokenizer.json", "tokenizer_config.json",
    "preprocessor_config.json", "model.safetensors", "model.safetensors.index.json",
    "added_tokens.json", "special_tokens_map.json", "generation_config.json",
    "chat_template.json", "chat_template.jinja", "merges.txt", "vocab.json",
    "video_preprocessor_config.json", "README.md", ".gitattributes",
]
REQUIRED_MODEL_FILES = {
    "config.json", "tokenizer.json", "tokenizer_config.json",
    "preprocessor_config.json", "model.safetensors",
}
ENVIRONMENTS = {
    "ls-env": ("label-studio", {"label-studio": "1.23.2", "label-studio-sdk": "2.1.2", "pillow": "12.3.0", "rawpy": "0.27.1"}),
    "mlx-env": ("model", {"mlx-vlm": "0.7.4", "mlx": "0.32.3",
                            "huggingface-hub": "1.6.0", "pillow": "12.3.0"}),
}


class SetupError(ValueError):
    """Fixed categories only; original stderr and configuration stay private."""


def check(condition, category):
    if not condition:
        raise SetupError(category)


def normalized_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_lock(file):
    """Require exact registry versions; reject a source URL or executable path."""
    text = Path(file).read_text(encoding="utf-8")
    versions = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            stripped = stripped[:-1].rstrip()
        if stripped.startswith("--hash="):
            check(re.fullmatch(r"--hash=sha256:[0-9a-f]{64}", stripped) is not None, "LOCK_HASH_FORMAT_INVALID")
            continue
        match = re.fullmatch(r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+!-]*)", stripped)
        check(match is not None, "LOCK_NOT_EXACT_REGISTRY_PINS")
        key, version = normalized_name(match[1]), match[2]
        check(key not in versions, "LOCK_DUPLICATE_PACKAGE")
        versions[key] = version
    check(bool(versions), "LOCK_EMPTY")
    return versions, hashlib.sha256(text.encode()).hexdigest(), "--hash=sha256:" in text


def model_metadata(code):
    metadata = json.loads((Path(code) / "runtime-metadata.json").read_text(encoding="utf-8"))
    check(all(metadata.get(key) == value for key, value in PINNED_MODEL.items()), "MODEL_MANIFEST_PIN_MISMATCH")
    check(metadata.get("python") == "3.12", "PYTHON_PIN_MISMATCH")
    check(metadata.get("mlx_vlm") == "0.7.4" and metadata.get("mlx") == "0.32.3", "RUNTIME_PIN_MISMATCH")
    return metadata


def safe_private_root(root, create=False):
    root = Path(root).absolute()
    check(root not in (Path("/"), Path.home(), Path("/Users"), Path("/Volumes")), "TASK_PRIVATE_ROOT_REQUIRED")
    for ancestor in (root, *root.parents):
        check(not ancestor.is_symlink(), "TASK_ROOT_SYMLINK_REFUSED")
    if create:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.exists():
        info = root.stat()
        check(root.is_dir() and info.st_uid == os.getuid() and not (info.st_mode & 0o077), "TASK_ROOT_NOT_PRIVATE")
    return root


def private_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@contextlib.contextmanager
def setup_lock(root):
    """Keep the lock file; release only our advisory lock at process exit."""
    directory = Path(root) / "state"
    check(not directory.is_symlink(), "SETUP_STATE_SYMLINK_REFUSED")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / "setup.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupError("SETUP_ALREADY_RUNNING") from None
        yield
    finally:
        os.close(fd)


def anonymous_environment(root):
    """Whitelist ordinary machine context; do not inherit service/API tokens."""
    env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
    env.update({
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1",
        "UV_CACHE_DIR": str(Path(root) / "cache/uv"), "UV_NO_CONFIG": "1",
        "UV_PYTHON_DOWNLOADS": "never", "UV_KEYRING_PROVIDER": "disabled",
        "XDG_CONFIG_HOME": str(Path(root) / "cache/xdg-config"),
        "XDG_DATA_HOME": str(Path(root) / "cache/xdg-data"),
        "XDG_CACHE_HOME": str(Path(root) / "cache/xdg-cache"),
        "HF_HOME": str(Path(root) / "models/cache"), "HF_TOKEN": "",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1", "DO_NOT_TRACK": "1",
        "HF_HUB_DOWNLOAD_TIMEOUT": "60", "HF_HUB_ETAG_TIMEOUT": "30",
        "HF_HUB_DISABLE_XET": "1",
    })
    return env


class Runner:
    def __init__(self, root, deadline):
        self.root = Path(root)
        self.deadline = deadline
        self.environment = anonymous_environment(root)

    def run(self, arguments, category, *, capture=False, allow_failure=False):
        remaining = self.deadline - time.monotonic()
        check(remaining > 0, "SETUP_DEADLINE")
        directory = self.root / "logs"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        log = directory / f"setup-{category.lower()}-{uuid.uuid4().hex}.log"
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            child = subprocess.Popen([str(argument) for argument in arguments],
                                     env=self.environment, stdout=subprocess.PIPE if capture else output,
                                     stderr=output, start_new_session=True)
            try:
                stdout, _ = child.communicate(timeout=remaining)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
                raise SetupError("SETUP_DEADLINE_OR_CANCELLED") from None
            if child.returncode and not allow_failure:
                raise SetupError(category)
            return child.returncode, (stdout or b"").decode("utf-8", errors="replace")


def environment_versions(python, runner):
    script = ("import importlib.metadata as m,json;"
              "print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))")
    code, output = runner.run([python, "-I", "-c", script], "ENVIRONMENT_CHECK_FAILED", capture=True, allow_failure=True)
    if code:
        return None
    try:
        return {normalized_name(name): version for name, version in json.loads(output).items()}
    except (TypeError, ValueError, AttributeError):
        return None


def environment_action(exists, healthy):
    if not exists:
        return "create"
    check(healthy, "EXISTING_ENVIRONMENT_LOCK_DRIFT")
    return "reuse"


def venv_marker_valid(directory):
    marker = directory / "pyvenv.cfg"
    if not marker.is_file() or marker.is_symlink():
        return False
    fields = dict(line.split("=", 1) for line in marker.read_text().splitlines() if "=" in line)
    fields = {key.strip(): value.strip() for key, value in fields.items()}
    return fields.get("include-system-site-packages") == "false" and fields.get("version_info", fields.get("version", "")).startswith("3.12.")


def install_environment(name, code, root, uv, python, runner):
    group, required = ENVIRONMENTS[name]
    lock = Path(code) / group / "requirements.lock"
    pinned, lock_sha, hashes = parse_lock(lock)
    check(all(pinned.get(package) == version for package, version in required.items()), "LOCK_DIRECT_PIN_MISMATCH")
    directory = root / name
    check(not directory.is_symlink(), "ENVIRONMENT_SYMLINK_REFUSED")
    interpreter = directory / "bin/python"
    existed = directory.exists()
    if existed:
        check(directory.is_dir() and directory.stat().st_uid == os.getuid(), "ENVIRONMENT_NOT_TASK_OWNED")
        check(venv_marker_valid(directory), "ISOLATED_PYTHON_312_VENV_REQUIRED")
    versions = environment_versions(interpreter, runner) if interpreter.is_file() else None
    healthy = versions == pinned
    action = environment_action(existed, healthy)
    if action == "reuse":
        return {"state": "reused", "lock_sha256": lock_sha, "packages": len(pinned)}
    runner.run([uv, "--no-config", "venv", "--no-project", "--no-python-downloads", "--python", python, directory],
               "VENV_CREATION_FAILED")
    check(venv_marker_valid(directory), "ISOLATED_PYTHON_312_VENV_REQUIRED")
    command = [uv, "--no-config", "pip", "sync", "--python", interpreter,
               "--no-python-downloads", "--default-index", "https://pypi.org/simple",
               "--keyring-provider", "disabled", "--strict", lock]
    if hashes:
        command.insert(-1, "--require-hashes")
    runner.run(command, "LOCKED_DEPENDENCY_SYNC_FAILED")
    versions = environment_versions(interpreter, runner)
    check(versions == pinned, "INSTALLED_LOCK_MISMATCH")
    return {"state": "created", "lock_sha256": lock_sha, "packages": len(pinned)}


def model_ready(directory, metadata, deadline):
    if not all((directory / name).is_file() and not (directory / name).is_symlink() for name in REQUIRED_MODEL_FILES):
        return False
    weights = directory / metadata["weights_file"]
    if weights.is_symlink() or weights.stat().st_size != metadata["weights_size_bytes"]:
        return False
    checksum = hashlib.sha256()
    with weights.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            check(time.monotonic() < deadline, "SETUP_DEADLINE")
            checksum.update(chunk)
    return checksum.hexdigest() == metadata["weights_sha256"]


def prepare_model(root, metadata, runner):
    check(not (root / "models").is_symlink(), "MODEL_PARENT_SYMLINK_REFUSED")
    directory = root / "models" / MODEL_DIRECTORY
    check(not directory.is_symlink(), "MODEL_DIRECTORY_SYMLINK_REFUSED")
    if model_ready(directory, metadata, runner.deadline):
        return {"state": "reused_verified", "revision": metadata["model_revision"],
                "weights_size_bytes": metadata["weights_size_bytes"]}
    if directory.exists():
        raise SetupError("EXISTING_MODEL_NOT_VERIFIED")
    check(shutil.disk_usage(root).free > metadata["weights_size_bytes"] * 1.15,
          "INSUFFICIENT_MODEL_DOWNLOAD_SPACE")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # token=False explicitly refuses a cached login token. Only approved public
    # model artifacts are downloaded; no user file is sent to this provider.
    download = """import json,sys
from huggingface_hub import snapshot_download
spec=json.loads(sys.argv[1])
snapshot_download(repo_id=spec['model_id'],revision=spec['model_revision'],
    local_dir=sys.argv[2],allow_patterns=json.loads(sys.argv[3]),token=False,
    max_workers=2,etag_timeout=30)
"""
    runner.run([root / "mlx-env/bin/python", "-I", "-c", download,
                json.dumps({key: metadata[key] for key in ("model_id", "model_revision")}),
                directory, json.dumps(MODEL_FILES)], "ANONYMOUS_MODEL_DOWNLOAD_FAILED")
    check(model_ready(directory, metadata, runner.deadline), "MODEL_DOWNLOAD_DIGEST_MISMATCH")
    return {"state": "downloaded_verified", "revision": metadata["model_revision"],
            "weights_size_bytes": metadata["weights_size_bytes"]}


def native_prerequisites(code):
    repo = Path(code).parents[1]
    required = [
        "packages/contracts/dist/internal/editorial/index.js",
        "services/catalog-postgres/dist/index.js",
        "apps/admin/node_modules/payload/dist/index.js",
        "apps/admin/node_modules/next/dist/bin/next",
        "scripts/editorial/batch.mjs", "scripts/editorial/verify-cms.mjs",
    ]
    missing = [name for name in required if not (repo / name).is_file()]
    return {"state": "prerequisites_ready" if not missing else "not_built",
            "missing_repository_relative_paths": missing,
            "draft_roundtrip": "NOT_TESTED_BY_SETUP", "production": "NOT_AUTHORIZED_NOT_RUN"}


def interactive_choice():
    script = ('choose from list {"检查状态（不安装）", "首次配置 / 下载本地模型"} '
              'with prompt "ArtVenn 本地配置：仅此任务环境；不会外发真实照片。" '
              'default items {"检查状态（不安装）"}')
    try:
        value = subprocess.run(["/usr/bin/osascript", "-e", script],
                               capture_output=True, text=True, timeout=300, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise SetupError("SETUP_MENU_CANCELLED") from None
    if value == "false":
        raise SetupError("SETUP_MENU_CANCELLED")
    return "status" if value.startswith("检查状态") else "setup"


def status(code, root, metadata, runner):
    environments = {}
    for name, (group, required) in ENVIRONMENTS.items():
        pinned, lock_sha, _ = parse_lock(code / group / "requirements.lock")
        directory = root / name
        safe = directory.is_dir() and not directory.is_symlink() and directory.stat().st_uid == os.getuid() and venv_marker_valid(directory)
        interpreter = directory / "bin/python"
        versions = environment_versions(interpreter, runner) if safe and interpreter.is_file() else None
        complete = versions == pinned
        environments[name] = {"state": "locked_versions_ready" if complete else "missing_or_lock_drift",
                              "lock_sha256": lock_sha, "direct_versions": required}
    directory = root / "models" / MODEL_DIRECTORY
    ready = not (root / "models").is_symlink() and not directory.is_symlink() and model_ready(directory, metadata, runner.deadline)
    return {"local_setup": "dependency_and_model_readiness_only", "environments": environments,
            "model": {"state": "verified" if ready else "missing_or_not_verified",
                      "model_id": metadata["model_id"], "revision": metadata["model_revision"]},
            "native_development": native_prerequisites(code),
            "ai_inference": "NOT_TESTED_BY_SETUP", "real_material_outbound": "DISABLED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--code-dir", type=Path, default=CODE)
    parser.add_argument("--python", type=Path)
    parser.add_argument("--uv", type=Path)
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--interactive", action="store_true")
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--timeout-minutes", type=int, default=30)
    args = parser.parse_args()
    os.umask(0o077)
    check(platform.system() == "Darwin" and platform.machine() == "arm64", "APPLE_SILICON_MAC_REQUIRED")
    check(1 <= args.timeout_minutes <= 60, "SETUP_BUDGET_INVALID")
    choice = interactive_choice() if args.interactive else "status" if args.status else "setup"
    code = args.code_dir.resolve(strict=True)
    metadata = model_metadata(code)
    root = safe_private_root(args.root, create=choice != "status")
    if choice == "status" and not root.exists():
        print(json.dumps({"local_setup": "NOT_CONFIGURED", "native_development": native_prerequisites(code)}))
        return 0
    runner = Runner(root, time.monotonic() + args.timeout_minutes * 60)
    if choice == "status":
        print(json.dumps(status(code, root, metadata, runner)))
        return 0
    uv = args.uv or Path(shutil.which("uv") or "/opt/homebrew/bin/uv")
    check(uv.is_file() and os.access(uv, os.X_OK), "EXISTING_UV_REQUIRED")
    python = args.python
    if python is None:
        _, value = runner.run([uv, "--no-config", "python", "find", "3.12", "--system",
                               "--no-project", "--no-python-downloads"], "EXISTING_PYTHON_312_REQUIRED", capture=True)
        python = Path(value.strip())
    check(python.is_absolute() and python.is_file(), "EXISTING_PYTHON_312_REQUIRED")
    _, version = runner.run([python, "-I", "-c", "import sys;print('.'.join(map(str,sys.version_info[:2])))"],
                            "PYTHON_VERSION_CHECK_FAILED", capture=True)
    check(version.strip() == "3.12", "EXISTING_PYTHON_312_REQUIRED")
    with setup_lock(root):
        outcomes = {}
        for name in ENVIRONMENTS:
            print(json.dumps({"setup_stage": name, "status": "checking_task_environment"}), flush=True)
            outcomes[name] = install_environment(name, code, root, uv, python, runner)
        print(json.dumps({"setup_stage": "one_public_model", "status": "checking_fixed_revision"}), flush=True)
        model = prepare_model(root, metadata, runner)
        result = {"version": 1, "local_setup": "locked_dependencies_and_model_ready",
                  "environments": outcomes, "model": model,
                  "native_development": native_prerequisites(code),
                  "ai_inference": "NOT_TESTED_BY_SETUP", "real_material_outbound": "DISABLED",
                  "production_publication": "NOT_AUTHORIZED_NOT_RUN"}
        private_write(root / "state/setup-receipt.json", result)
    if args.open:
        runner.run([root / "ls-env/bin/python", code / "service.py", "start", "--root", root, "--open"],
                   "LOCAL_SERVICE_START_FAILED")
        result["local_service"] = "start_requested_use_existing_status_and_browser_validation"
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SetupError as error:
        print(json.dumps({"local_setup": "FAILED_OR_PRESERVED_DRIFT", "category": str(error),
                          "existing_materials": "PRESERVED"}))
        raise SystemExit(1)
    except KeyboardInterrupt:
        print(json.dumps({"local_setup": "CANCELLED", "existing_materials": "PRESERVED"}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"local_setup": "FAILED", "category": "SETUP_LOCAL_IO_FAILED",
                          "existing_materials": "PRESERVED"}))
        raise SystemExit(1)
