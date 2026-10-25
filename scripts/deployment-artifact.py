"""Publish and restore the exact JupyterLite bytes shared by Pages and RTD."""

import argparse
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ARCHIVE_NAME = "datax-site.tar.gz"
RELEASE_BASE = os.environ.get("DATAX_RELEASE_BASE", "https://github.com/datax-now/go/releases/download").rstrip("/")
# Build hosts supply the commit themselves when they have no usable Git checkout.
COMMIT_ENVIRONMENT = (
    "VERCEL_GIT_COMMIT_SHA", "READTHEDOCS_GIT_COMMIT_HASH", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA",
)
TRANSIENT_STATUS = (408, 429, 500, 502, 503, 504)
TRANSIENT_RETRIES = 3
GITHUB_API_BASE = os.environ.get("DATAX_GITHUB_API", "https://api.github.com/repos/datax-now/go").rstrip("/")
PAGES_WORKFLOW_PATH = ".github/workflows/deploy-github-pages.yml"
# Unauthenticated GitHub API calls are rate-limited, so the publish status is checked at most this often.
PAGES_CHECK_INTERVAL = 60
NETWORK_ERRORS = (URLError, TimeoutError, ConnectionError, ssl.SSLError, http.client.HTTPException)


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
    # hashlib.file_digest needs Python 3.11; Vercel's default python3 is older.
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
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


def unpack(archive: Path, directory: Path, commit: str, force: bool = False) -> None:
    if not force and (directory.exists() or directory.is_symlink()):
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
        if force and (directory.is_symlink() or directory.is_file()):
            directory.unlink()
        elif force and directory.exists():
            shutil.rmtree(directory)
        staging.rename(directory)
    print(f"Restored {len(seen)} verified files for {commit}")


def download(url: str, archive: Path) -> None:
    request = Request(url, headers={"User-Agent": "datax-now-deployment-artifact"})
    with urlopen(request, timeout=60) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
        expected = response.headers.get("Content-Length")
    # A connection dropped mid-stream can end the body early without an error.
    if expected is not None and expected.isdigit() and archive.stat().st_size != int(expected):
        raise http.client.IncompleteRead(b"", int(expected) - archive.stat().st_size)


def pages_publish_failed(commit: str) -> bool:
    # The newest run decides, so a manual re-run that is still in progress keeps the build waiting.
    request = Request(
        f"{GITHUB_API_BASE}/actions/runs?head_sha={commit}&per_page=100",
        headers={"User-Agent": "datax-now-deployment-artifact", "Accept": "application/vnd.github+json"},
    )
    try:
        with urlopen(request, timeout=30) as response:
            runs = json.load(response).get("workflow_runs", [])
    except (*NETWORK_ERRORS, ValueError):
        return False
    runs = [run for run in runs if run.get("path") == PAGES_WORKFLOW_PATH]
    if not runs:
        return False
    latest = max(runs, key=lambda run: run.get("id", 0))
    return latest.get("status") == "completed" and latest.get("conclusion") != "success"


def restore(
    commit: str, directory: Path, wait_seconds: int, allow_missing: bool = False, force: bool = False,
) -> int:
    if not force and (directory.exists() or directory.is_symlink()):
        raise FileExistsError(f"Refusing to replace existing deployment: {directory}")
    url = f"{RELEASE_BASE}/site-{commit}/{ARCHIVE_NAME}"
    deadline = time.monotonic() + wait_seconds
    next_pages_check = 0.0
    transient = 0
    with tempfile.TemporaryDirectory(prefix="datax-download-") as temporary:
        archive = Path(temporary) / ARCHIVE_NAME
        while True:
            try:
                download(url, archive)
                break
            except NETWORK_ERRORS as error:
                missing = False
                if isinstance(error, HTTPError):
                    error.close()
                    missing = error.code == 404
                    if not missing and error.code not in TRANSIENT_STATUS:
                        raise
                remaining = deadline - time.monotonic()
                if missing:
                    if time.monotonic() >= next_pages_check:
                        next_pages_check = time.monotonic() + PAGES_CHECK_INTERVAL
                        if pages_publish_failed(commit):
                            # The publisher has finished without an artifact, so waiting longer cannot help.
                            if allow_missing:
                                print(
                                    f"GitHub Pages publish failed for {commit}; no artifact will appear",
                                    file=sys.stderr,
                                )
                                return 3
                            raise RuntimeError(
                                f"GitHub Pages publish failed for {commit}. Fix the workflow, then retry the build."
                            ) from error
                    if allow_missing and remaining <= 0:
                        print(f"No published artifact for {commit}", file=sys.stderr)
                        return 3
                    delay = 15
                else:
                    transient += 1
                    # Short outages are retried even when the caller does not want to wait for a release.
                    delay = 5 * min(transient, 3)
                if remaining <= 0 and (missing or transient > TRANSIENT_RETRIES):
                    raise RuntimeError(
                        f"Cannot download artifact for {commit}: {error}. "
                        "Complete the GitHub Pages workflow for this commit, then retry the RTD build "
                        "(or the Vercel or Cloudflare build)."
                    ) from error
                print(f"Artifact not available yet ({error}); waiting for site-{commit}", flush=True)
                time.sleep(min(delay, remaining) if remaining > 0 else delay)
        unpack(archive, directory, commit, force)
    return 0


def release_is_public(commit: str) -> bool:
    request = Request(
        f"{RELEASE_BASE}/site-{commit}/{ARCHIVE_NAME}", method="HEAD",
        headers={"User-Agent": "datax-now-deployment-artifact"},
    )
    try:
        with urlopen(request, timeout=60):
            return True
    except NETWORK_ERRORS:
        return False


def gh(*args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["gh", *args], check=True, text=True, stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def publish(directory: Path, commit: str, repo: "str | None" = None) -> int:
    """Publish the verified site as an immutable release; tolerate a concurrent publisher."""
    tag = f"site-{commit}"
    scope = ["--repo", repo] if repo else []
    with tempfile.TemporaryDirectory(prefix="datax-publish-") as temporary:
        archive = Path(temporary) / ARCHIVE_NAME
        pack(directory, archive, commit)
        releases = json.loads(gh("release", "list", "--limit", "100", "--json", "tagName,isDraft", *scope, capture=True) or "[]")
        for release in releases:
            if release.get("tagName") != tag:
                continue
            if not release.get("isDraft"):
                print(f"{tag} is already published; leaving it unchanged")
                return 0
            # An interrupted upload leaves an unpublished draft that would block this tag.
            print(f"Removing incomplete draft release {tag}")
            gh("release", "delete", tag, "--yes", *scope)
        try:
            gh(
                "release", "create", tag, str(archive), "--target", commit, "--draft", "--latest=false",
                "--title", f"JupyterLite site {commit}",
                "--notes", "Canonical deployment shared by GitHub Pages, Read the Docs, Vercel and Cloudflare Pages. "
                "Do not replace this artifact; publish a new commit instead.",
                *scope,
            )
            gh("release", "edit", tag, "--draft=false", "--latest=false", *scope)
        except subprocess.CalledProcessError:
            if release_is_public(commit):
                print(f"{tag} was published by a concurrent run")
                return 0
            raise
    print(f"Published {tag}")
    return 0


def resolve_commit(explicit: "str | None" = None, environ=os.environ) -> str:
    if explicit:
        return explicit
    # The checkout is authoritative: GITHUB_SHA names the dispatching ref, not a manually selected release_ref.
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    for name in COMMIT_ENVIRONMENT:
        if environ.get(name):
            return environ[name].strip().lower()
    raise ValueError(
        "Could not determine the Git commit; pass --commit or set VERCEL_GIT_COMMIT_SHA, "
        "READTHEDOCS_GIT_COMMIT_HASH, CF_PAGES_COMMIT_SHA or GITHUB_SHA"
    )


def default_wait() -> int:
    value = os.environ.get("DATAX_ARTIFACT_WAIT_SECONDS", "600")
    return int(value) if value.isdigit() else -1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    pack_parser = subparsers.add_parser("pack")
    pack_parser.add_argument("directory", type=Path)
    pack_parser.add_argument("archive", type=Path)
    publish_parser = subparsers.add_parser("publish", help="pack a verified site and publish it as a GitHub release")
    publish_parser.add_argument("directory", type=Path)
    publish_parser.add_argument("--repo", help="owner/name; defaults to the current checkout's repository")
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--output", type=Path, default=Path("dist"))
    restore_parser.add_argument("--wait-seconds", type=int, default=default_wait())
    restore_parser.add_argument("--allow-missing", action="store_true")
    restore_parser.add_argument("--force", action="store_true", help="replace an existing output directory")
    for command in (pack_parser, publish_parser, restore_parser):
        command.add_argument("--commit")
    args = parser.parse_args()
    commit = resolve_commit(args.commit)
    if re.fullmatch(r"[0-9a-f]{40,64}", commit) is None:
        parser.error("Expected a full Git commit SHA")
    if args.command == "pack":
        pack(args.directory, args.archive, commit)
        return 0
    if args.command == "publish":
        return publish(args.directory, commit, args.repo)
    if args.wait_seconds < 0:
        parser.error("--wait-seconds (or DATAX_ARTIFACT_WAIT_SECONDS) must be a nonnegative integer")
    return restore(commit, args.output, args.wait_seconds, args.allow_missing, args.force)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"Deployment artifact error: {error}", file=sys.stderr)
        sys.exit(1)
