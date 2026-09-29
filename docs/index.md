# DataX.now

Run JupyterLab directly in your browser with the DataX.now workspace.

## Open the workspace

- [Launch DataX.now](https://datax.now) — the fastest option. Some company networks
  may block it.
- <a href="_static/lab/index.html">Open the Read the Docs JupyterLab build</a> — a
  same-origin option for networks that allow this documentation site.
- <a href="https://datax-now.helloway.workers.dev/lab/">Open the Cloudflare mirror</a> —
  an independent application host.
- <a href="_static/datax-now.zip">Download the local DataX.now deployment</a> — for faster access, use <a href="https://datax.now">datax.now</a> instead.

Choose one host for a session. Notebook files and browser storage are separate
on each origin; export important work before switching hosts.

After extracting the download, run `python cors_server.py` from the unzipped
folder to start a local instance of DataX.now.

## About this site

This page is the Read the Docs front page for the generated JupyterLite site.
The application runs entirely in the browser, with no separate application
server required.

To customize the workspace, add notebooks and data files to `notebooks/` or
update the JSON configuration files at the repository root.