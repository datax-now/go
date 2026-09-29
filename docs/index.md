# DataX.now

Run JupyterLab directly in your browser with the DataX.now workspace.

## Open the workspace

Hosts are listed in priority order; use the first one that works for your network.

- <a href="_static/lab/index.html">Open the Read the Docs JupyterLab build</a> — a
  same-origin option for networks that allow this documentation site.
- <a href="https://datax-now.github.io/go/">Open the GitHub Pages deployment</a> — an
  independent application host.
- <a href="https://datax.now">Open the Vercel deployment (datax.now)</a> — the fastest
  host to download from. Some company networks may block it.
- <a href="https://datax-now.pages.dev/lab/">Open the Cloudflare Pages mirror</a> —
  an independent application host.
- <a href="_static/datax-now.zip">Download the local DataX.now deployment</a> — for faster access, use one of the hosts above instead.

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