"""Publish and restore the exact JupyterLite bytes shared by Pages and RTD."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


ARCHIVE_NAME = "datax-site.tar.gz"
RELEASE_BASE = "https://github.com/datax-now/go/releases/download"


def validate_path(name: str) -> None:
    path = PurePosixPath(name)
    if (
        not name or path.is_absolute() or ".." in path.parts
        or "\\" in name or str(path) != name or name == "."
    ):
        raise ValueError(f"Unsafe artifact path: {name!r}")


def read_manifest(data: bytes, commit: str) -> dict:
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get("format") != 1 or manifest.get("commit") != commit:
        raise ValueError(f"Artifact manifest does not match expected commit {commit}")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Artifact manifest has no file inventory")
    for name, entry in files.items():
        validate_path(name)
        if name == "deployment.json" or not isinstance(entry, dict):
            raise ValueError(f"Invalid artifact inventory entry: {name}")
        if (
            type(entry.get("bytes")) is not int or entry["bytes"] < 0
            or not isinstance(entry.get("sha256"), str)
            or re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", "")) is None
        ):
            raise ValueError(f"Invalid artifact size or digest: {name}")
    return manifest


def verify_file(path: Path, entry: dict) -> None:
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if path.stat().st_size != entry["bytes"] or digest != entry["sha256"]:
        raise ValueError(f"Artifact integrity mismatch: {path.name}")


def pack(directory: Path, archive: Path, commit: str) -> None:
    directory = directory.resolve()
    if archive.resolve().is_relative_to(directory):
        raise ValueError("Write the artifact outside the deployment directory")
    manifest = read_manifest((directory / "deployment.json").read_bytes(), commit)
    expected = {"deployment.json", *manifest["files"]}
    actual = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Artifact cannot contain symlinks: {path}")
        if path.is_file():
            actual.add(path.relative_to(directory).as_posix())
    if actual != expected:
        raise ValueError("Deployment files do not match the manifest inventory")
    for name, entry in manifest["files"].items():
        verify_file(directory / name, entry)
    with archive.open("xb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as target:
                for name in ["deployment.json", *sorted(manifest["files"])]:
                    path = directory / name
                    member = tarfile.TarInfo(name)
                    member.size = path.stat().st_size
                    member.mode = 0o644
                    with path.open("rb") as source:
                        target.addfile(member, source)
    print(f"Packed {len(expected)} verified files for {commit}")


def unpack(archive: Path, directory: Path, commit: str) -> None:
    if directory.exists() or directory.is_symlink():
        raise FileExistsError(f"Refusing to replace existing deployment: {directory}")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".datax-restore-", dir=directory.parent) as temporary:
        staging = Path(temporary) / "site"
        staging.mkdir()
        with tarfile.open(archive, mode="r|gz") as source:
            first = source.next()
            if first is None or first.name != "deployment.json" or not first.isfile():
                raise ValueError("Artifact must start with a regular deployment.json file")
            manifest_stream = source.extractfile(first)
            if manifest_stream is None or first.size > 8 * 1024 * 1024:
                raise ValueError("Invalid artifact manifest")
            manifest_bytes = manifest_stream.read()
            manifest = read_manifest(manifest_bytes, commit)
            (staging / "deployment.json").write_bytes(manifest_bytes)
            seen = {"deployment.json"}
            for member in source:
                if member is first:
                    continue
                validate_path(member.name)
                entry = manifest["files"].get(member.name)
                if member.name in seen or entry is None or not member.isfile():
                    raise ValueError(f"Unexpected artifact member: {member.name}")
                if member.size != entry["bytes"]:
                    raise ValueError(f"Artifact size mismatch: {member.name}")
                payload = source.extractfile(member)
                if payload is None:
                    raise ValueError(f"Missing artifact payload: {member.name}")
                destination = staging / member.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as output:
                    shutil.copyfileobj(payload, output)
                verify_file(destination, entry)
                seen.add(member.name)
            if seen != {"deployment.json", *manifest["files"]}:
                raise ValueError("Artifact is missing inventoried files")
        staging.rename(directory)
    print(f"Restored {len(seen)} verified files for {commit}")


def restore(commit: str, directory: Path, wait_seconds: int, allow_missing: bool = False) -> int:
    if directory.exists() or directory.is_symlink():
        raise FileExistsError(f"Refusing to replace existing deployment: {directory}")
    url = f"{RELEASE_BASE}/site-{commit}/{ARCHIVE_NAME}"
    deadline = time.monotonic() + wait_seconds
    with tempfile.TemporaryDirectory(prefix="datax-download-") as temporary:
        archive = Path(temporary) / ARCHIVE_NAME
        while True:
            try:
                with urlopen(url, timeout=60) as response, archive.open("wb") as output:
                    shutil.copyfileobj(response, output)
                break
            except (HTTPError, URLError, TimeoutError) as error:
                if isinstance(error, HTTPError):
                    error.close()
                    if error.code == 404 and allow_missing:
                        print(f"No published artifact for {commit}", file=sys.stderr)
                        return 3
                    if error.code not in (404, 429, 500, 502, 503, 504):
                        raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(
                        f"Cannot download artifact for {commit}: {error}. "
                        "Complete the GitHub Pages workflow for this commit, then retry the RTD build."
                    ) from error
                print(f"Artifact not available yet ({error}); waiting for site-{commit}", flush=True)
                time.sleep(min(15, remaining))
        unpack(archive, directory, commit)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    pack_parser = subparsers.add_parser("pack")
    pack_parser.add_argument("directory", type=Path)
    pack_parser.add_argument("archive", type=Path)
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--output", type=Path, default=Path("dist"))
    restore_parser.add_argument("--wait-seconds", type=int, default=600)
    restore_parser.add_argument("--allow-missing", action="store_true")
    for command in (pack_parser, restore_parser):
        command.add_argument("--commit")
    args = parser.parse_args()
    commit = args.commit or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if re.fullmatch(r"[0-9a-f]{40,64}", commit) is None:
        parser.error("Expected a full Git commit SHA")
    if args.command == "pack":
        pack(args.directory, args.archive, commit)
        return 0
    if args.wait_seconds < 0:
        parser.error("--wait-seconds must be nonnegative")
    return restore(commit, args.output, args.wait_seconds, args.allow_missing)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, tarfile.TarError) as error:
        print(f"Deployment artifact error: {error}", file=sys.stderr)
        sys.exit(1)
