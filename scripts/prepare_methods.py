"""Copy this release's provider-specific method marketplace to stable BB state.

Run from the installed BB plugin. Native marketplace/plugin updates remain
separate native CLI operations. This helper never reads OAuth or model config.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

PLUGIN_ID = "svaib-workplace"
MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 1024


class PreparationError(ValueError):
    pass


def _regular(path: Path, limit: int) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise PreparationError("Expected a regular file")
    with path.open("rb") as source:
        raw = source.read(limit + 1)
    if len(raw) > limit:
        raise PreparationError("File limit exceeded")
    return raw


def _object(path: Path) -> dict:
    value = json.loads(_regular(path, 512 * 1024))
    if not isinstance(value, dict):
        raise PreparationError("Expected an object")
    return value


def _snapshot(root: Path, expected: dict) -> dict[str, bytes]:
    if root.is_symlink() or not root.is_dir():
        raise PreparationError("Expected a real directory")
    if not isinstance(expected, dict) or not 1 <= len(expected) <= MAX_FILES:
        raise PreparationError("Invalid file manifest")
    allowed_directories = set()
    for name, digest in expected.items():
        path = PurePosixPath(name)
        if (not isinstance(name, str) or path.is_absolute() or "\\" in name
                or str(path) != name or any(p in ("", ".", "..") for p in path.parts)
                or not isinstance(digest, str) or len(digest) != 64
                or any(c not in "0123456789abcdef" for c in digest)):
            raise PreparationError("Invalid manifest path or digest")
        allowed_directories.update(str(p) for p in path.parents if str(p) != ".")
    actual = {}
    size = 0
    for walk_root, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            full = Path(walk_root) / name
            if (full.is_symlink()
                    or full.relative_to(root).as_posix() not in allowed_directories):
                raise PreparationError("Symlink or unowned directory in marketplace")
        for name in files:
            full = Path(walk_root) / name
            relative = full.relative_to(root).as_posix()
            if relative not in expected:
                raise PreparationError("Unowned file in marketplace")
            raw = _regular(full, 4 * 1024 * 1024)
            size += len(raw)
            if size > MAX_BYTES or hashlib.sha256(raw).hexdigest() != expected[relative]:
                raise PreparationError("Marketplace content does not match its manifest")
            actual[relative] = raw
    if set(actual) != set(expected):
        raise PreparationError("Missing marketplace files")
    return actual


def _directory(path: Path) -> None:
    if path.is_symlink():
        raise PreparationError("Symlink in destination path")
    path.mkdir(exist_ok=True)
    if not path.is_dir():
        raise PreparationError("Expected a destination directory")


def _version(value: object) -> tuple[int, int, int]:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value) is None:
        raise PreparationError("Expected a stable method version")
    return tuple(int(part) for part in value.split("."))


def _host(files: dict[str, bytes], provider: str) -> None:
    config = json.loads(files["plugins/svaib/hooks/hooks.json"])
    found = set()
    for groups in config["hooks"].values():
        for group in groups:
            for hook in group["hooks"]:
                command = hook.get("command", "")
                for name in ("inject_company.py", "inject_space_map.py"):
                    if name in command:
                        if shlex.split(command)[-1] != provider:
                            raise PreparationError("Wrong native host in method hooks")
                        found.add(name)
    if found != {"inject_company.py", "inject_space_map.py"}:
        raise PreparationError("Required native host hooks are missing")


@contextmanager
def _locked(path: Path):
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise PreparationError("Another method preparation owns the destination lock") from None
    try:
        yield
    finally:
        os.close(descriptor)
        path.unlink()


def prepare(provider: str, data_dir: Path, *, source_root: Path | None = None) -> dict:
    if provider not in ("codex", "claude"):
        raise PreparationError("Unsupported provider")
    source_root = source_root or Path(__file__).resolve().parents[1]
    package = _object(source_root / "package.json")
    if package.get("name") != "bb-plugin-svaib-workplace":
        raise PreparationError("Unexpected BB plugin source")
    manifest = _object(source_root / "methods/manifest.json")
    if manifest.get("schema") != 1 or not isinstance(manifest.get("providers"), dict):
        raise PreparationError("Unsupported method manifest")
    entry = manifest["providers"].get(provider)
    if (not isinstance(entry, dict) or entry.get("root") != "methods/" + provider
            or entry.get("host") != provider or not isinstance(entry.get("version"), str)):
        raise PreparationError("Provider manifest mismatch")
    new_version = _version(entry["version"])
    source = source_root / "methods" / provider
    if (source_root / "methods").is_symlink():
        raise PreparationError("Symlink in source path")
    files = _snapshot(source, entry.get("files"))
    _host(files, provider)
    plugin = json.loads(files["plugins/svaib/.claude-plugin/plugin.json"])
    catalog = json.loads(files[".claude-plugin/marketplace.json"])
    entries = catalog.get("plugins")
    if (plugin.get("name") != "svaib" or plugin.get("version") != entry["version"]
            or catalog.get("name") != "svaib"
            or not isinstance(entries, list) or len(entries) != 1
            or not isinstance(entries[0], dict) or entries[0].get("name") != "svaib"
            or entries[0].get("source") != "./plugins/svaib"
            or entries[0].get("version") != entry["version"]):
        raise PreparationError("Method package identity mismatch")
    if (not data_dir.is_absolute() or data_dir.resolve() != data_dir
            or not data_dir.is_dir()):
        raise PreparationError("Use the canonical BB data directory from bb status")
    parent = data_dir
    for segment in ("plugins", PLUGIN_ID, "methods"):
        parent = parent / segment
        _directory(parent)
    with _locked(parent / (".prepare-" + provider + ".lock")):
        target = parent / provider
        marker = parent / ("." + provider + ".owner.json")
        owner = {"schema": 1, "pluginId": PLUGIN_ID, "provider": provider,
                 "version": entry["version"], "sourceRevision": manifest.get("sourceRevision"),
                 "files": entry["files"]}
        if target.exists() or target.is_symlink() or marker.exists() or marker.is_symlink():
            old_owner = _object(marker)
            if (old_owner.get("schema") != 1 or old_owner.get("pluginId") != PLUGIN_ID
                    or old_owner.get("provider") != provider):
                raise PreparationError("Existing marketplace is not owned by this installer")
            if _version(old_owner.get("version")) > new_version:
                raise PreparationError("Refusing an implicit method downgrade")
            _snapshot(target, old_owner.get("files"))
            if old_owner == owner:
                return {"marketplaceRoot": str(target), "version": entry["version"],
                        "provider": provider, "changed": False}
        temp = Path(tempfile.mkdtemp(prefix=".prepare-" + provider + "-", dir=parent))
        previous = None
        replaced = False
        try:
            for name, raw in files.items():
                full = temp / name
                full.parent.mkdir(parents=True, exist_ok=True)
                full.write_bytes(raw)
            _snapshot(temp, entry["files"])
            if target.exists():
                previous = parent / (".previous-" + provider + "-" + uuid.uuid4().hex)
                target.rename(previous)
            temp.rename(target)
            replaced = True
            marker_temp = parent / (".owner-" + uuid.uuid4().hex + ".json")
            marker_temp.write_text(json.dumps(owner, sort_keys=True, indent=2) + "\n")
            os.replace(marker_temp, marker)
        except BaseException:
            if replaced:
                target.rename(temp)
            if previous is not None:
                previous.rename(target)
            raise
        finally:
            if temp.exists():
                shutil.rmtree(temp)
        return {"marketplaceRoot": str(target), "version": entry["version"],
                "provider": provider, "changed": True}



def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=("codex", "claude"), required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.provider, args.data_dir)
    except (ValueError, OSError, KeyError, IndexError, TypeError):
        parser.exit(1, "Method preparation refused: source or owned destination validation failed.\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
