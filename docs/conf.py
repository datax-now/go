"""Minimal Sphinx shell used to publish the JupyterLite build on RTD."""

from pathlib import Path


HERE = Path(__file__).parent

project = "JupyterLite on Read the Docs"
copyright = "2026, contributors"
release = "latest"

extensions = ["myst_parser"]
myst_heading_anchors = 3

templates_path = ["_templates"]
html_static_path = ["../dist"]
html_theme = "sphinx_rtd_theme"
exclude_patterns = ["_build", ".ipynb_checkpoints", "**/.ipynb_checkpoints"]