#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
import tempfile
import zipfile
from pathlib import Path


OLD_M3 = 'function m3(t,e){if(t==="number")return fe("~s");let r=Ul(e[0].x0,e[e.length-1].x1,e.length);return HP[r.unit]}'
NEW_M3 = 'function m3(t,e){if(t==="number")return fe("~s");if(!e.length)return tr("%Y-%m-%d");let r=Ul(e[0].x0,e[e.length-1].x1,e.length);return HP[r.unit]??tr("%Y-%m-%d")}'

OLD_EC = 'C=[Math.min(...t.map(M=>M.x0)),Math.max(...t.map(M=>M.x1))],S=r==="date"?wu():Pr();S.domain(C).range([c+w+b,n-a]).nice();'
NEW_EC = 'C=t.length?[Math.min(...t.map(M=>M.x0)),Math.max(...t.map(M=>M.x1))]:[0,1],S=r==="date"?wu():Pr();(!Number.isFinite(+C[0])||!Number.isFinite(+C[1]))&&(C=[0,1]),+C[0]===+C[1]&&(C=r==="date"?[new Date(+C[0]-432e5),new Date(+C[1]+432e5)]:[+C[0]-.5,+C[1]+.5]),S.domain(C).range([c+w+b,n-a]).nice();'

OLD_NULL_TICK = 'append("g").attr("transform",`translate(${M(.5)}, 0)`).attr("class","tick");'
NEW_NULL_TICK = 'append("g").attr("transform",`translate(${Number.isFinite(M(.5))?M(.5):0}, 0)`).attr("class","tick");'

PATCH_MARKER = 'Number.isFinite(+C[0])'


def patch_text(text: str) -> tuple[str, bool]:
    if all(pattern in text for pattern in (NEW_M3, NEW_EC, NEW_NULL_TICK)):
        return text, False

    patched = text
    replacements = [
        (OLD_M3, NEW_M3),
        (OLD_EC, NEW_EC),
        (OLD_NULL_TICK, NEW_NULL_TICK),
    ]
    changed = False
    for old, new in replacements:
        if old in patched:
            patched = patched.replace(old, new, 1)
            changed = True

    if not changed:
        raise RuntimeError("Known quak widget patterns not found; patch would be unsafe.")

    missing = [new for old, new in replacements if new not in patched or old in patched]
    if missing:
        raise RuntimeError("Patch left expected original pattern(s) behind.")

    return patched, True


def patch_file(path: Path) -> bool:
    original = path.read_text()
    patched, changed = patch_text(original)
    if changed:
        path.write_text(patched)
    return changed


def patch_tarball(path: Path) -> bool:
    changed = False
    with tempfile.TemporaryDirectory(prefix="quak-patch-") as tmpdir:
        tmpdir_path = Path(tmpdir)
        with tarfile.open(path, "r:gz") as archive:
            archive.extractall(tmpdir_path)

        widget_paths = list(tmpdir_path.rglob("site-packages/quak/widget.js"))
        if not widget_paths:
            raise RuntimeError(f"No quak/widget.js found inside {path}")

        for widget_path in widget_paths:
            changed = patch_file(widget_path) or changed

        if changed:
            tmp_tar = path.with_suffix(path.suffix + ".tmp")
            with tarfile.open(tmp_tar, "w:gz") as archive:
                for file_path in sorted(tmpdir_path.rglob("*")):
                    archive.add(file_path, arcname=file_path.relative_to(tmpdir_path))
            tmp_tar.replace(path)

    return changed


def patch_conda(path: Path) -> bool:
    import zstandard

    with zipfile.ZipFile(path) as archive:
        contents = {name: archive.read(name) for name in archive.namelist()}
    package_name = next(name for name in contents if name.startswith("pkg-") and name.endswith(".tar.zst"))
    info_name = next(name for name in contents if name.startswith("info-") and name.endswith(".tar.zst"))
    patched_files = {}

    def rewrite_tar(compressed: bytes, transform) -> bytes:
        output = io.BytesIO()
        with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(compressed)) as stream:
            with tarfile.open(fileobj=stream, mode="r|") as source:
                with tarfile.open(fileobj=output, mode="w") as target:
                    for member in source:
                        if member.isfile():
                            data = transform(member.name, source.extractfile(member).read())
                            member.size = len(data)
                            target.addfile(member, io.BytesIO(data))
                        else:
                            target.addfile(member)
        return zstandard.ZstdCompressor().compress(output.getvalue())

    found_widget = False

    def patch_widget(name: str, data: bytes) -> bytes:
        nonlocal found_widget
        if name.endswith("quak/widget.js"):
            found_widget = True
            patched, changed = patch_text(data.decode("utf-8"))
            if changed:
                data = patched.encode("utf-8")
                patched_files[name] = data
        return data

    contents[package_name] = rewrite_tar(contents[package_name], patch_widget)
    if not found_widget:
        raise RuntimeError(f"No quak/widget.js found inside {path}")
    if not patched_files:
        return False

    def patch_metadata(name: str, data: bytes) -> bytes:
        if name == "info/paths.json":
            metadata = json.loads(data)
            for entry in metadata["paths"]:
                patched = patched_files.get(entry["_path"])
                if patched is not None:
                    entry["sha256"] = hashlib.sha256(patched).hexdigest()
                    entry["size_in_bytes"] = len(patched)
            return json.dumps(metadata).encode("utf-8")
        return data

    contents[info_name] = rewrite_tar(contents[info_name], patch_metadata)
    temporary = path.with_suffix(".conda.tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name, data in contents.items():
                archive.writestr(name, data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def patch_path(path: Path) -> bool:
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix == ".conda":
        return patch_conda(path)
    if path.suffixes[-2:] == [".tar", ".gz"]:
        return patch_tarball(path)
    return patch_file(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Patch quak widget bundle for degenerate histogram domains.")
    parser.add_argument("paths", nargs="+", help="Files, .tar.gz or .conda packages to patch")
    args = parser.parse_args()

    changed_any = False
    for raw_path in args.paths:
        path = Path(raw_path)
        changed = patch_path(path)
        state = "patched" if changed else "already patched"
        print(f"{state}: {path}")
        changed_any = changed_any or changed

    return 0 if changed_any or args.paths else 1


if __name__ == "__main__":
    raise SystemExit(main())
