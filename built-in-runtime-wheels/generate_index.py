#!/usr/bin/env python3

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path


def _normalize_name(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).strip('-').lower()


def _hash_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def _read_metadata(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        metadata_name = next(
            (name for name in archive.namelist() if name.endswith('.dist-info/METADATA')),
            None,
        )
        if metadata_name is None:
            raise ValueError(f'Could not find METADATA in {path.name}')

        parsed = {}
        for line in archive.read(metadata_name).decode('utf-8', errors='replace').splitlines():
            if not line or line[0].isspace():
                break
            key, _, value = line.partition(':')
            if key in ('Name', 'Version'):
                parsed[key] = value.strip()
        return parsed


def _append_package_record(packages: dict, normalized_name: str, record: dict) -> None:
    existing = packages.get(normalized_name)
    if existing is None:
        packages[normalized_name] = record
    elif isinstance(existing, list):
        existing.append(record)
    else:
        packages[normalized_name] = [existing, record]


def _build_index(root: Path) -> dict:
    packages = {}
    for wheel in sorted(root.glob('*.whl')):
        metadata = _read_metadata(wheel)
        name = metadata.get('Name')
        version = metadata.get('Version')
        if not name or not version:
            raise ValueError(f'Wheel metadata missing Name/Version for {wheel.name}')

        normalized_name = _normalize_name(name)
        _append_package_record(packages, normalized_name, {
            'name': name,
            'version': version,
            'filename': wheel.name,
            'sha256': _hash_file(wheel),
            'size': wheel.stat().st_size,
        })

    return {'version': 1, 'packages': packages}


def _validate_index(root: Path, expected_index: dict) -> None:
    index_path = root / 'index.json'
    if not index_path.exists():
        raise FileNotFoundError(f'Missing runtime wheel index: {index_path}')

    current_index = json.loads(index_path.read_text(encoding='utf-8'))
    if current_index != expected_index:
        raise ValueError('index.json is stale; regenerate it with generate_index.py')

    expected_filenames = {
        record['filename']
        for value in expected_index.get('packages', {}).values()
        for record in (value if isinstance(value, list) else [value])
    }
    missing = sorted(filename for filename in expected_filenames if not (root / filename).exists())
    if missing:
        raise FileNotFoundError(
            f'Missing wheel artifacts referenced by index.json: {", ".join(missing)}'
        )


def main() -> int:
    parser = argparse.ArgumentParser(description='Generate runtime wheel index metadata')
    parser.add_argument('root', nargs='?', default=Path(__file__).resolve().parent, type=Path)
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()

    root = args.root.resolve()
    index = _build_index(root)

    if args.validate_only:
        _validate_index(root, index)
        return 0

    (root / 'index.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
