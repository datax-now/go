import argparse
import copy
import filecmp
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile


VOLATILE_PAX_FIELDS = {"mtime", "atime", "ctime", "uid", "gid", "uname", "gname"}


def normalize_metadata(path: Path) -> bool:
    original = path.read_text()
    metadata = json.loads(original)
    if not isinstance(metadata.get("packages"), list):
        raise ValueError(f"Kernel metadata must contain a packages array: {path}")
    metadata["packages"].sort(key=lambda package: json.dumps(package, sort_keys=True))
    normalized = json.dumps(metadata, indent=2, sort_keys=True) + "\n"
    if original == normalized:
        return False
    path.write_text(normalized)
    return True


def normalize_archive(path: Path, epoch: int) -> bool:
    with tarfile.open(path, mode="r:gz") as source:
        with tempfile.TemporaryDirectory(prefix=".datax-package-", dir=path.parent) as temporary:
            output = Path(temporary) / path.name
            with output.open("wb") as raw:
                with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=9) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as target:
                        # Hard links and repeated paths can depend on preceding members.
                        for original in source:
                            if original.issparse():
                                raise ValueError(f"Sparse kernel package member is unsupported: {path}: {original.name}")
                            member = copy.copy(original)
                            member.mtime = epoch
                            member.uid = member.gid = 0
                            member.uname = member.gname = ""
                            member.pax_headers = {
                                key: value for key, value in original.pax_headers.items()
                                if key not in VOLATILE_PAX_FIELDS
                            }
                            if member.isfile():
                                payload = source.extractfile(original)
                                if payload is None:
                                    raise ValueError(f"Missing kernel package payload: {path}: {member.name}")
                                with payload:
                                    target.addfile(member, payload)
                            else:
                                target.addfile(member)
            if filecmp.cmp(path, output, shallow=False):
                return False
            shutil.copymode(path, output)
            output.replace(path)
            return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Normalize kernel metadata and package archives before SHA-256 fingerprinting.")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if not args.directory.is_dir():
        parser.error(f"Deployment directory does not exist: {args.directory}")
    value = os.environ.get("SOURCE_DATE_EPOCH", "0")
    if re.fullmatch(r"[0-9]+", value) is None:
        parser.error("SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp")
    epoch = int(value)
    metadata = sorted((args.directory / "xeus").glob("*/empack_env_meta.json"))
    changed_metadata = sum(normalize_metadata(path) for path in metadata)
    packages = sorted((args.directory / "xeus").glob("*/kernel_packages/*.tar.gz"))
    changed = sum(normalize_archive(package, epoch) for package in packages)
    print(f"Normalized {changed_metadata}/{len(metadata)} kernel metadata files for reproducible mirror downloads")
    print(f"Normalized {changed}/{len(packages)} kernel package archives for reproducible mirror downloads")


if __name__ == "__main__":
    main()
