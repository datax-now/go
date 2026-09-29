#!/usr/bin/env python3

import argparse
import hashlib
import io
import json
import tarfile
import zipfile
from pathlib import Path


def _hash_file(path: Path, algorithm: str) -> str:
    hasher = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def _load_json_from_tar_bytes(data: bytes, member_name: str) -> dict:
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        member = archive.getmember(member_name)
        extracted = archive.extractfile(member)
        if extracted is None:
            raise ValueError(f'Failed to extract {member_name}')
        return json.loads(extracted.read().decode('utf-8'))


def _extract_conda_info_index(path: Path) -> dict:
    try:
        import zstandard  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            'Reading .conda packages requires the zstandard package to be available'
        ) from exc

    with zipfile.ZipFile(path) as archive:
        info_member = next(
            (name for name in archive.namelist() if name.startswith('info-') and name.endswith('.tar.zst')),
            None,
        )
        if info_member is None:
            raise ValueError(f'Could not locate info-*.tar.zst in {path.name}')

        compressed = archive.read(info_member)
        decompressor = zstandard.ZstdDecompressor()
        with decompressor.stream_reader(io.BytesIO(compressed)) as reader:
            payload = reader.read()
        return _load_json_from_tar_bytes(payload, 'info/index.json')


def _extract_tar_bz2_info_index(path: Path) -> dict:
    with tarfile.open(path, mode='r:bz2') as archive:
        member = archive.getmember('info/index.json')
        extracted = archive.extractfile(member)
        if extracted is None:
            raise ValueError(f'Failed to extract info/index.json from {path.name}')
        return json.loads(extracted.read().decode('utf-8'))


def _package_record(path: Path) -> tuple[str, dict, bool]:
    if path.suffix == '.conda':
        info_index = _extract_conda_info_index(path)
        is_conda_package = True
    else:
        info_index = _extract_tar_bz2_info_index(path)
        is_conda_package = False

    record = {
        'name': info_index['name'],
        'version': info_index['version'],
        'build': info_index['build'],
        'build_number': info_index.get('build_number', 0),
        'depends': info_index.get('depends', []),
        'subdir': info_index.get('subdir'),
        'md5': _hash_file(path, 'md5'),
        'sha256': _hash_file(path, 'sha256'),
        'size': path.stat().st_size,
    }

    for field in ('license', 'timestamp', 'track_features', 'constrains', 'noarch'):
        if field in info_index:
            record[field] = info_index[field]

    return path.name, record, is_conda_package


def _build_repodata(subdir: str, package_dir: Path) -> dict:
    packages = {}
    packages_conda = {}

    archives = sorted(package_dir.glob('*.tar.bz2')) + sorted(package_dir.glob('*.conda'))
    for archive in archives:
        filename, record, is_conda_package = _package_record(archive)
        target = packages_conda if is_conda_package else packages
        target[filename] = record

    return {
        'info': {'subdir': subdir},
        'packages': packages,
        'packages.conda': packages_conda,
        'repodata_version': 1,
    }


def _validate_repodata(package_dir: Path, repodata: dict) -> None:
    missing = []
    for section in ('packages', 'packages.conda'):
        for filename in repodata.get(section, {}):
            if not (package_dir / filename).exists():
                missing.append(filename)
    if missing:
        raise FileNotFoundError(
            f'Missing package artifacts for {package_dir}: {", ".join(sorted(missing))}'
        )


def main() -> int:
    parser = argparse.ArgumentParser(description='Generate repodata.json files for built-in conda channels')
    parser.add_argument('root', nargs='?', default=Path(__file__).resolve().parent, type=Path)
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()

    root = args.root.resolve()

    # mambajs requires both emscripten-wasm32 and noarch subdirs in every
    # conda channel, even when one of them contains no packages.  Ensure
    # both always exist so the generated channel is always valid.
    required_subdirs = ['emscripten-wasm32', 'noarch']
    for name in required_subdirs:
        (root / name).mkdir(parents=True, exist_ok=True)

    subdirs = [path for path in sorted(root.iterdir()) if path.is_dir()]

    for subdir_path in subdirs:
        repodata_path = subdir_path / 'repodata.json'
        if args.validate_only and repodata_path.exists():
            repodata = json.loads(repodata_path.read_text())
            _validate_repodata(subdir_path, repodata)
            continue

        repodata = _build_repodata(subdir_path.name, subdir_path)
        _validate_repodata(subdir_path, repodata)
        repodata_json = json.dumps(repodata, indent=2) + '\n'
        repodata_path.write_text(repodata_json)

        # Also write repodata.json.zst so micromamba doesn't emit
        # "Failed to load subdir" warnings when it tries the compressed
        # variant before falling back to plain JSON.
        try:
            import zstandard  # type: ignore
            zst_path = subdir_path / 'repodata.json.zst'
            compressor = zstandard.ZstdCompressor(level=3)
            zst_path.write_bytes(compressor.compress(repodata_json.encode('utf-8')))
        except ImportError:
            print(
                f'  ⚠ zstandard not installed — skipping {subdir_path.name}/repodata.json.zst '
                '(micromamba will fall back to .json, but install zstandard to suppress this warning)'
            )

    return 0


if __name__ == '__main__':
    raise SystemExit(main())