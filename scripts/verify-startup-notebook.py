#!/usr/bin/env python3
"""Verify the JupyterLite startup-notebook fallback configuration."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    overrides_path = repo_root / "overrides.json"
    notebooks_root = repo_root / "notebooks"

    data = json.loads(overrides_path.read_text(encoding="utf-8"))
    plugin_settings = data.get("datax-now-front:plugin")
    if not isinstance(plugin_settings, dict):
        print("Missing datax-now-front:plugin settings in overrides.json", file=sys.stderr)
        return 1

    startup_notebook = plugin_settings.get("startupNotebook")
    if not isinstance(startup_notebook, str) or not startup_notebook.strip():
        print("Missing non-empty datax-now-front:plugin.startupNotebook setting", file=sys.stderr)
        return 1

    normalized = startup_notebook.strip().lstrip("/")
    notebook_path = repo_root / normalized
    source_notebook_path = notebooks_root / normalized
    if not notebook_path.is_file() and not source_notebook_path.is_file():
        print(
            f"Configured startup notebook does not exist: {startup_notebook}",
            file=sys.stderr,
        )
        return 1

    print(f"startupNotebook={startup_notebook}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
