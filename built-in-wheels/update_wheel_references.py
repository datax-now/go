#!/usr/bin/env python3
"""
Automatically update or validate wheel file references in YAML files.

This script scans the built-in-wheels directory, identifies the latest version of
tracked packages, refreshes YAML references to those latest wheel filenames, and
can validate that existing YAML pins are still fresh.

Usage:
    python update_wheel_references.py [--dry-run] [--validate-only]
    python update_wheel_references.py [--package PKG] [--yaml-dir DIR]

Options:
    --dry-run         Show what would be changed without modifying files
    --validate-only   Fail if YAML references are missing, stale, or point to
                      missing wheel files
    --package PKG     Limit updates/validation to one or more packages
    --yaml-dir DIR    Directory or file to search for YAML files (repeatable)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

try:
    from packaging.version import parse as parse_version
except ImportError:
    # Fallback for environments without packaging.
    def parse_version(v: str):  # type: ignore[misc]
        parts = []
        for segment in re.split(r'[.\-]', v):
            try:
                parts.append((0, int(segment)))
            except ValueError:
                parts.append((1, segment))
        return parts


WHEEL_REF_PATTERN = re.compile(r'(?:\./)?built-in-wheels/([^#\s]+\.whl)')
WHEEL_LINE_PATTERN = re.compile(
    r'^(\s*-\s+(?:\./)?built-in-wheels/)([^#\s]+\.whl)(\s*)$',
    re.MULTILINE,
)
WHEEL_FILENAME_PATTERN = re.compile(r'^(.+?)-([0-9][^-]*.*?)-(py\d+|cp\d+)-.+\.whl$')


def normalize_package_name(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).strip('-').lower()


def extract_wheel_info(wheel_filename: str) -> Tuple[Optional[str], Optional[str], str]:
    match = WHEEL_FILENAME_PATTERN.match(wheel_filename)
    if match:
        package_name = match.group(1)
        version = match.group(2)
        return package_name, version, wheel_filename
    return None, None, wheel_filename


def iter_wheel_records(wheels_dir: Path) -> Iterable[Tuple[str, str, str]]:
    for wheel_file in sorted(wheels_dir.glob('*.whl')):
        package_name, version, filename = extract_wheel_info(wheel_file.name)
        if package_name and version:
            yield package_name, version, filename


def find_latest_wheels(
    wheels_dir: Path,
    package_filter: Optional[Set[str]] = None,
) -> Tuple[Dict[str, str], Dict[str, List[Tuple[str, str]]]]:
    packages: Dict[str, List[Tuple[str, str]]] = {}

    for package_name, version, filename in iter_wheel_records(wheels_dir):
        normalized = normalize_package_name(package_name)
        if package_filter and normalized not in package_filter:
            continue
        packages.setdefault(normalized, []).append((version, filename))

    latest_wheels: Dict[str, str] = {}
    package_versions: Dict[str, List[Tuple[str, str]]] = {}
    for normalized, versions in packages.items():
        versions.sort(key=lambda item: parse_version(item[0]), reverse=True)
        latest_wheels[normalized] = versions[0][1]
        package_versions[normalized] = versions

    return latest_wheels, package_versions


def _display_path(path: Path, project_root: Path) -> str:
    try:
        return str(path.relative_to(project_root))
    except ValueError:
        return str(path)


def find_yaml_files(search_paths: Sequence[Path]) -> List[Path]:
    yaml_files: List[Path] = []
    for path in search_paths:
        if path.is_file() and path.suffix in ['.yml', '.yaml']:
            yaml_files.append(path)
        elif path.is_dir():
            yaml_files.extend(path.glob('**/*.yml'))
            yaml_files.extend(path.glob('**/*.yaml'))
    return sorted(dict.fromkeys(yaml_files))


def find_referenced_wheels(
    yaml_files: Sequence[Path],
    package_filter: Optional[Set[str]] = None,
) -> Tuple[Set[str], Dict[str, Set[str]]]:
    referenced: Set[str] = set()
    by_package: Dict[str, Set[str]] = {}

    for yaml_file in yaml_files:
        try:
            content = yaml_file.read_text(encoding='utf-8')
        except Exception as exc:
            print(f"⚠️  Error reading {yaml_file}: {exc}")
            continue

        for filename in WHEEL_REF_PATTERN.findall(content):
            package_name, _, _ = extract_wheel_info(filename)
            if not package_name:
                continue
            normalized = normalize_package_name(package_name)
            if package_filter and normalized not in package_filter:
                continue
            referenced.add(filename)
            by_package.setdefault(normalized, set()).add(filename)

    return referenced, by_package


def update_yaml_file(
    yaml_file: Path,
    latest_wheels: Dict[str, str],
    project_root: Path,
    packages_filter: Optional[Set[str]] = None,
    dry_run: bool = False,
) -> bool:
    try:
        content = yaml_file.read_text(encoding='utf-8')
    except Exception as exc:
        print(f"⚠️  Error reading {yaml_file}: {exc}")
        return False

    changes_made: List[Tuple[str, str, str]] = []

    def replace_wheel(match: re.Match[str]) -> str:
        prefix, filename, suffix = match.groups()
        package_name, old_version, _ = extract_wheel_info(filename)
        if not package_name or not old_version:
            return match.group(0)

        normalized = normalize_package_name(package_name)
        if packages_filter and normalized not in packages_filter:
            return match.group(0)

        latest_wheel = latest_wheels.get(normalized)
        if not latest_wheel or latest_wheel == filename:
            return match.group(0)

        _, latest_version, _ = extract_wheel_info(latest_wheel)
        changes_made.append((package_name, old_version, latest_version or 'unknown'))
        return f"{prefix}{latest_wheel}{suffix}"

    updated_content = WHEEL_LINE_PATTERN.sub(replace_wheel, content)
    if updated_content == content:
        return False

    if dry_run:
        print(f"\n📄 {_display_path(yaml_file, project_root)}:")
        for package_name, old_version, new_version in changes_made:
            print(f"   {package_name}: {old_version} → {new_version}")
        return True

    try:
        yaml_file.write_text(updated_content, encoding='utf-8')
    except Exception as exc:
        print(f"⚠️  Error writing {yaml_file}: {exc}")
        return False

    print(f"\n✅ Updated {_display_path(yaml_file, project_root)}:")
    for package_name, old_version, new_version in changes_made:
        print(f"   {package_name}: {old_version} → {new_version}")
    return True


def validate_yaml_files(
    yaml_files: Sequence[Path],
    latest_wheels: Dict[str, str],
    wheels_dir: Path,
    project_root: Path,
    packages_filter: Optional[Set[str]] = None,
) -> int:
    errors = 0
    referenced_wheels, referenced_by_package = find_referenced_wheels(yaml_files, packages_filter)
    del referenced_wheels  # package-level validation below is more precise.

    if packages_filter:
        selected_packages = set(packages_filter)
    else:
        selected_packages = set(referenced_by_package)

    for normalized in sorted(selected_packages):
        package_refs = referenced_by_package.get(normalized, set())
        if not package_refs:
            print(f"❌ No YAML reference found for package {normalized}")
            errors += 1
            continue

        latest_filename = latest_wheels.get(normalized)
        if not latest_filename:
            print(f"❌ No wheel file found for referenced package: {normalized}")
            errors += 1
            continue

        for filename in sorted(package_refs):
            wheel_path = wheels_dir / filename
            if not wheel_path.is_file():
                print(f"❌ Missing wheel referenced by YAML: built-in-wheels/{filename}")
                errors += 1

        stale_refs = sorted(filename for filename in package_refs if filename != latest_filename)
        if stale_refs:
            print(
                f"❌ Stale YAML reference for {normalized}: expected {latest_filename}, found {', '.join(stale_refs)}"
            )
            errors += 1

    if errors == 0:
        print("✅ Wheel references are up to date")
    else:
        print(f"\nValidation failed with {errors} issue(s)")

    return errors


def prune_stale_wheels(
    wheels_dir: Path,
    latest_wheels: Dict[str, str],
    package_versions: Dict[str, List[Tuple[str, str]]],
    preserved_wheels: Set[str],
    packages_filter: Optional[Set[str]] = None,
) -> None:
    for normalized, versions in sorted(package_versions.items()):
        if packages_filter and normalized not in packages_filter:
            continue

        latest_filename = latest_wheels[normalized]
        if len(versions) > 1:
            latest_version = versions[0][0]
            print(f"📦 {normalized}: Found {len(versions)} versions, latest is {latest_version}")

        for version, filename in versions[1:]:
            if filename == latest_filename:
                continue
            if filename in preserved_wheels:
                print(f"📌 Preserving pinned wheel: {filename}")
                continue
            stale_path = wheels_dir / filename
            try:
                stale_path.unlink()
                print(f"🗑  Removed stale wheel: {filename}")
            except Exception as exc:
                print(f"⚠️  Could not remove {filename}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Update wheel file references in YAML files to latest versions',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be changed without modifying files',
    )
    parser.add_argument(
        '--validate-only',
        action='store_true',
        help='Fail if YAML references are stale or missing instead of modifying files',
    )
    parser.add_argument(
        '--package',
        action='append',
        default=[],
        help='Limit updates/validation to one or more packages',
    )
    parser.add_argument(
        '--yaml-dir',
        type=Path,
        action='append',
        help='Directory or file to search for YAML files (can be specified multiple times)',
    )

    args = parser.parse_args()

    script_dir = Path(__file__).parent.resolve()
    project_root = script_dir.parent
    package_filter = {normalize_package_name(pkg) for pkg in args.package} or None

    if args.yaml_dir:
        search_paths = args.yaml_dir
    else:
        search_paths = [
            project_root / 'environment-deploy.yml',
            project_root / 'environment-wasm-host.yml',
        ]
        search_paths = [path for path in search_paths if path.exists()]

    print(f"\n🔍 Searching for YAML files in: {[str(path) for path in search_paths]}")
    yaml_files = find_yaml_files(search_paths)
    if not yaml_files:
        print('❌ No YAML files found!')
        return 1

    print(f"📝 Found {len(yaml_files)} YAML file(s)")
    if package_filter:
        print(f"🎯 Limiting operation to package(s): {', '.join(sorted(package_filter))}")

    latest_wheels, package_versions = find_latest_wheels(script_dir, package_filter)
    if not latest_wheels:
        print('❌ No wheel files found!')
        return 1

    print(f"\n📋 Latest versions:")
    for normalized, filename in sorted(latest_wheels.items()):
        print(f"   {normalized}: {filename}")

    if args.validate_only:
        return 1 if validate_yaml_files(
            yaml_files,
            latest_wheels,
            script_dir,
            project_root,
            package_filter,
        ) else 0

    if args.dry_run:
        print('\n🔍 DRY RUN MODE - No files will be modified\n')

    modified_count = 0
    for yaml_file in yaml_files:
        if update_yaml_file(
            yaml_file,
            latest_wheels,
            project_root,
            package_filter,
            args.dry_run,
        ):
            modified_count += 1

    preserved_wheels, _ = find_referenced_wheels(yaml_files, package_filter)
    if not args.dry_run:
        prune_stale_wheels(
            script_dir,
            latest_wheels,
            package_versions,
            preserved_wheels,
            package_filter,
        )

    print(f"\n{'Would modify' if args.dry_run else 'Modified'} {modified_count} file(s)")
    if args.dry_run and modified_count > 0:
        print('\nRun without --dry-run to apply changes')

    if not args.dry_run:
        validation_errors = validate_yaml_files(
            yaml_files,
            latest_wheels,
            script_dir,
            project_root,
            package_filter,
        )
        if validation_errors:
            return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
