"""Synthetic filesystem and mocked subprocess regressions; never install/download."""
import hashlib
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("curation_setup", Path(__file__).with_name("setup.py"))
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.deadline = time.monotonic() + 30

    def run(self, args, category, **kwargs):
        self.calls.append([str(arg) for arg in args])
        if category == "VENV_CREATION_FAILED":
            make_venv(Path(args[-1]))
        return 0, ""


def make_venv(directory, system=False):
    (directory / "bin").mkdir(parents=True, mode=0o700)
    (directory / "bin/python").write_text("synthetic interpreter marker")
    (directory / "pyvenv.cfg").write_text(
        "version_info = 3.12.9\ninclude-system-site-packages = " + ("true" if system else "false") + "\n")


class SetupTests(unittest.TestCase):
    def setUp(self):
        # Keep only these newly-created synthetic test files. No cleanup/deletion
        # action is part of the setup implementation or this acceptance test.
        self.folder = Path(tempfile.mkdtemp(prefix="artvenn-setup-test-", dir="/private/tmp"))
        self.root = self.folder / "runtime"
        self.root.mkdir(mode=0o700)
        self.code = self.folder / "code"
        (self.code / "label-studio").mkdir(parents=True)
        (self.code / "model").mkdir()
        self.pins = setup.ENVIRONMENTS["ls-env"][1]
        (self.code / "label-studio/requirements.lock").write_text(
            "".join(f"{name}=={version} \\\n    --hash=sha256:{'a' * 64}\n" for name, version in self.pins.items()))
        self.runner = FakeRunner()

    def test_pinned_lock_normalization_and_hashes(self):
        versions, digest, hashes = setup.parse_lock(self.code / "label-studio/requirements.lock")
        self.assertEqual(versions, self.pins)
        self.assertEqual(len(digest), 64)
        self.assertTrue(hashes)

    def test_source_url_rejected(self):
        lock = self.folder / "invalid.lock"
        lock.write_text("example @ https://example.invalid/package.whl\n")
        with self.assertRaisesRegex(setup.SetupError, "LOCK_NOT_EXACT_REGISTRY_PINS"):
            setup.parse_lock(lock)

    def test_duplicate_package_rejected(self):
        lock = self.folder / "invalid.lock"
        lock.write_text("Pillow==12.3.0\npillow==12.3.0\n")
        with self.assertRaisesRegex(setup.SetupError, "LOCK_DUPLICATE_PACKAGE"):
            setup.parse_lock(lock)

    def test_incomplete_hash_rejected(self):
        lock = self.folder / "invalid.lock"
        lock.write_text("pillow==12.3.0 \\\n --hash=sha256:abc\n")
        with self.assertRaisesRegex(setup.SetupError, "LOCK_HASH_FORMAT_INVALID"):
            setup.parse_lock(lock)

    def test_existing_complete_environment_never_syncs(self):
        make_venv(self.root / "ls-env")
        with patch.object(setup, "environment_versions", return_value=dict(self.pins)):
            result = setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(result["state"], "reused")
        self.assertEqual(self.runner.calls, [])

    def test_existing_extra_distribution_refused_without_sync(self):
        make_venv(self.root / "ls-env")
        versions = dict(self.pins, synthetic_extra="0.1.0")
        with patch.object(setup, "environment_versions", return_value=versions):
            with self.assertRaisesRegex(setup.SetupError, "EXISTING_ENVIRONMENT_LOCK_DRIFT"):
                setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(self.runner.calls, [])
        self.assertTrue((self.root / "ls-env/pyvenv.cfg").is_file())

    def test_existing_wrong_version_refused_without_sync(self):
        make_venv(self.root / "ls-env")
        versions = dict(self.pins, pillow="0.0.0")
        with patch.object(setup, "environment_versions", return_value=versions):
            with self.assertRaisesRegex(setup.SetupError, "EXISTING_ENVIRONMENT_LOCK_DRIFT"):
                setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(self.runner.calls, [])

    def test_existing_incomplete_environment_refused_without_sync(self):
        (self.root / "ls-env").mkdir()
        with self.assertRaisesRegex(setup.SetupError, "ISOLATED_PYTHON_312_VENV_REQUIRED"):
            setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(self.runner.calls, [])

    def test_system_site_packages_refused(self):
        make_venv(self.root / "ls-env", system=True)
        with self.assertRaisesRegex(setup.SetupError, "ISOLATED_PYTHON_312_VENV_REQUIRED"):
            setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(self.runner.calls, [])

    def test_new_environment_syncs_only_frozen_lock(self):
        with patch.object(setup, "environment_versions", return_value=dict(self.pins)):
            result = setup.install_environment("ls-env", self.code, self.root, "uv", "python3.12", self.runner)
        self.assertEqual(result["state"], "created")
        self.assertEqual(len(self.runner.calls), 2)
        creation, sync = self.runner.calls
        self.assertNotIn("--allow-existing", creation)
        self.assertIn("--no-python-downloads", creation)
        self.assertEqual(sync[2:4], ["pip", "sync"])
        self.assertIn("--require-hashes", sync)
        self.assertEqual(sync[-1], str(self.code / "label-studio/requirements.lock"))
        self.assertNotIn("install", sync)

    def test_anonymous_environment_does_not_inherit_tokens(self):
        synthetic = {"HOME": "/synthetic/home", "PATH": "/synthetic/bin", "HF_TOKEN": "SYNTHETIC_PLACEHOLDER",
                     "OPENAI_API_KEY": "SYNTHETIC_PLACEHOLDER", "UV_INDEX_URL": "https://synthetic.invalid"}
        with patch.dict(os.environ, synthetic, clear=True):
            env = setup.anonymous_environment(self.root)
        self.assertEqual(env["HF_TOKEN"], "")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("UV_INDEX_URL", env)
        for key in ("HF_HOME", "UV_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
            self.assertTrue(Path(env[key]).is_relative_to(self.root))

    def test_private_root_symlink_refused(self):
        alias = self.folder / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(setup.SetupError, "TASK_ROOT_SYMLINK_REFUSED"):
            setup.safe_private_root(alias)

    def test_model_metadata_cannot_select_other_model(self):
        metadata = dict(setup.PINNED_MODEL, python="3.12", mlx_vlm="0.7.4", mlx="0.32.3")
        (self.code / "runtime-metadata.json").write_text(json.dumps(metadata))
        self.assertEqual(setup.model_metadata(self.code)["model_id"], setup.PINNED_MODEL["model_id"])
        metadata["model_revision"] = "0" * 40
        (self.code / "runtime-metadata.json").write_text(json.dumps(metadata))
        with self.assertRaisesRegex(setup.SetupError, "MODEL_MANIFEST_PIN_MISMATCH"):
            setup.model_metadata(self.code)

    def test_existing_incomplete_model_preserved_no_download(self):
        directory = self.root / "models" / setup.MODEL_DIRECTORY
        directory.mkdir(parents=True)
        marker = directory / "synthetic-existing-marker"
        marker.write_text("SYNTHETIC FIXTURE")
        with self.assertRaisesRegex(setup.SetupError, "EXISTING_MODEL_NOT_VERIFIED"):
            setup.prepare_model(self.root, dict(setup.PINNED_MODEL), self.runner)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(marker.read_text(), "SYNTHETIC FIXTURE")

    def test_model_content_digest_and_no_symlink(self):
        directory = self.root / "synthetic-model"
        directory.mkdir()
        for filename in setup.REQUIRED_MODEL_FILES:
            (directory / filename).write_bytes(b"SYNTHETIC FIXTURE")
        metadata = {"weights_file": "model.safetensors", "weights_size_bytes": 17,
                    "weights_sha256": hashlib.sha256(b"SYNTHETIC FIXTURE").hexdigest()}
        self.assertTrue(setup.model_ready(directory, metadata, self.runner.deadline))
        metadata["weights_sha256"] = "0" * 64
        self.assertFalse(setup.model_ready(directory, metadata, self.runner.deadline))

    def test_duplicate_setup_refused_and_lock_file_kept(self):
        with setup.setup_lock(self.root):
            with self.assertRaisesRegex(setup.SetupError, "SETUP_ALREADY_RUNNING"):
                with setup.setup_lock(self.root):
                    self.fail("must not acquire duplicate setup lock")
        self.assertTrue((self.root / "state/setup.lock").is_file())


if __name__ == "__main__":
    unittest.main()
