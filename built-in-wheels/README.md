# Build wheels

The wheels in this directory are checked-in inputs for the Read the Docs
JupyterLite build. They include the custom Xeus addon, the browser kernel
payload, and the JupyterLab extensions used by the notebooks.

When replacing a wheel, copy it into this directory and refresh the matching
filename in `environment-deploy.yml`:

```bash
python built-in-wheels/update_wheel_references.py
python built-in-wheels/update_wheel_references.py --validate-only
```

Do not place generated `dist/` files here. Read the Docs needs these inputs in
the repository because it performs a clean build.