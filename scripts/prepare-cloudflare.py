"""Prepare a built site for Cloudflare Pages Free-plan limits.

Cloudflare Pages rejects files above 25 MiB, sites above 20,000 files, and
`_headers` files with more than 100 rules. Oversized files are stored gzip-
compressed and served with a matching Content-Encoding rule, so browsers still
receive the original bytes.
"""

import argparse
import gzip
import os
from pathlib import Path
import shutil
import sys

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 20000
MAX_HEADER_RULES = 100
MAX_HEADER_LINE = 2000
# `_headers` treats `*` as a splat and `:name` as a placeholder, so such paths cannot be matched literally.
UNMATCHABLE = set("*: \t")


def compress_in_place(path: Path) -> int:
    temporary = path.with_name(path.name + ".gz-tmp")
    with path.open("rb") as source, temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0) as target:
            shutil.copyfileobj(source, target)
    shutil.copymode(path, temporary)
    temporary.replace(path)
    return path.stat().st_size


def prepare(source: Path, output: "Path | None", headers: Path) -> dict:
    root = source.resolve()
    if output is not None:
        output = output.resolve()
        if output.exists():
            raise FileExistsError(f"Refusing to reuse existing output directory: {output}")
        if output == root or root in output.parents or output in root.parents:
            raise ValueError("The Cloudflare output must be separate from the source directory")
        shutil.copytree(root, output, symlinks=True)
        root = output
    if not headers.is_file():
        raise FileNotFoundError(f"Missing Cloudflare headers file: {headers}")

    rules = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Cloudflare Pages cannot publish symlinks: {path.relative_to(root)}")
        if not path.is_file() or path.stat().st_size <= MAX_FILE_BYTES:
            continue
        relative = path.relative_to(root).as_posix()
        if UNMATCHABLE.intersection(relative):
            raise ValueError(f"Cannot write a literal Cloudflare header rule for {relative!r}")
        compressed = compress_in_place(path)
        if compressed > MAX_FILE_BYTES:
            raise ValueError(
                f"Asset remains above the Cloudflare Pages 25 MiB limit after gzip: {relative} ({compressed} bytes)"
            )
        rules.append(f"/{relative}\n  Content-Encoding: gzip\n")

    text = headers.read_text(encoding="utf-8").rstrip("\n") + "\n"
    if "\n/" not in "\n" + text:
        raise ValueError("The Cloudflare headers file defines no rules")
    base_rules = sum(1 for line in text.splitlines() if line.startswith("/"))
    if base_rules + len(rules) > MAX_HEADER_RULES:
        raise ValueError(
            f"Cloudflare Pages allows {MAX_HEADER_RULES} header rules; this site needs {base_rules + len(rules)}"
        )
    combined = text + "".join("\n" + rule for rule in rules)
    longest = max(len(line) for line in combined.splitlines())
    if longest > MAX_HEADER_LINE:
        raise ValueError(f"Cloudflare Pages limits _headers lines to {MAX_HEADER_LINE} characters")
    (root / "_headers").write_text(combined, encoding="utf-8")

    files = sum(1 for path in root.rglob("*") if path.is_file())
    if files > MAX_FILES:
        raise ValueError(f"Cloudflare Pages Free allows up to {MAX_FILES:,} files; found {files:,}")
    if not (root / "deployment.json").is_file():
        raise ValueError("The site has no deployment.json to verify after upload")
    return {"directory": root, "files": files, "compressed": len(rules)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="built site (dist/)")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--output", type=Path, help="copy the site here before preparing it")
    target.add_argument("--in-place", action="store_true", help="prepare the source directory itself")
    parser.add_argument(
        "--headers", type=Path, default=Path(__file__).resolve().parent.parent / "cloudflare" / "_headers",
    )
    parser.add_argument("--github-env", type=Path, default=os.environ.get("GITHUB_ENV") and Path(os.environ["GITHUB_ENV"]))
    args = parser.parse_args()
    result = prepare(args.source, None if args.in_place else args.output, args.headers)
    print(f"Prepared {result['files']} files for Cloudflare Pages ({result['compressed']} gzip-compressed)")
    if args.github_env:
        with args.github_env.open("a", encoding="utf-8") as env:
            env.write(f"PAGES_DIR={result['directory']}\nFILE_COUNT={result['files']}\n")
            env.write(f"COMPRESSED_FILES={result['compressed']}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"Cloudflare preparation error: {error}", file=sys.stderr)
        sys.exit(1)
