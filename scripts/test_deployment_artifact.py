import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import threading
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("artifact", Path(__file__).with_name("deployment-artifact.py"))
artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifact)
COMMIT = "a" * 40


class DeploymentArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.site = self.root / "pages"
        self.site.mkdir()
        self.contents = {
            "lab/index.html": b"<html>DataX</html>",
            "xeus/host/kernel_packages/r-evaluate.tar.gz": b"R database with build-specific timestamp",
            "xeus/host/cairo.so.asm": b"\0asm build-specific WASM bytes",
            "service-worker.js": b"const expectedHashes = 'build-specific';",
        }
        self.manifest = {
            "format": 1, "commit": COMMIT,
            "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                      for name, data in self.contents.items()},
        }
        for name, data in self.contents.items():
            path = self.site / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (self.site / "deployment.json").write_text(json.dumps(self.manifest))
        self.archive = self.root / artifact.ARCHIVE_NAME
        self.output = self.root / "rtd"

    def make_archive(self, entries):
        with tarfile.open(self.archive, "w:gz") as target:
            for name, data, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = len(data) if kind == tarfile.REGTYPE else 0
                if kind == tarfile.SYMTYPE:
                    member.linkname = "../outside"
                target.addfile(member, io.BytesIO(data) if member.isfile() else None)

    def valid_entries(self):
        return [("deployment.json", json.dumps(self.manifest).encode(), tarfile.REGTYPE)] + [
            (name, data, tarfile.REGTYPE) for name, data in self.contents.items()
        ]

    def test_rtd_receives_exact_pages_inventory_and_build_specific_payloads(self):
        artifact.pack(self.site, self.archive, COMMIT)
        artifact.unpack(self.archive, self.output, COMMIT)
        for source in self.site.rglob("*"):
            if source.is_file():
                self.assertEqual(source.read_bytes(), (self.output / source.relative_to(self.site)).read_bytes())
        second = self.root / "second.tar.gz"
        artifact.pack(self.site, second, COMMIT)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())

    def test_corruption_wrong_commit_and_incomplete_inventory_never_publish(self):
        entries = self.valid_entries()
        for label, modified, commit in [
            ("wrong commit", entries, "b" * 40),
            ("missing file", entries[:-1], COMMIT),
            ("changed bytes", entries[:-1] + [(entries[-1][0], b"x" * len(entries[-1][1]), tarfile.REGTYPE)], COMMIT),
            ("duplicate file", entries + [entries[-1]], COMMIT),
            ("extra file", entries + [("extra", b"extra", tarfile.REGTYPE)], COMMIT),
            ("symlink", entries[:-1] + [(entries[-1][0], b"", tarfile.SYMTYPE)], COMMIT),
            ("traversal", entries + [("../outside", b"unsafe", tarfile.REGTYPE)], COMMIT),
        ]:
            with self.subTest(label=label):
                self.make_archive(modified)
                with self.assertRaises(ValueError):
                    artifact.unpack(self.archive, self.output, commit)
                self.assertFalse(self.output.exists())
                self.assertFalse((self.root / "outside").exists())
                self.assertFalse(list(self.root.glob(".datax-restore-*")))

    def test_pack_rejects_uninventoried_changed_or_linked_files(self):
        path = self.site / "service-worker.js"
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "integrity"):
            artifact.pack(self.site, self.archive, COMMIT)
        path.write_bytes(self.contents["service-worker.js"])
        extra = self.site / "extra"
        extra.write_text("extra")
        with self.assertRaisesRegex(ValueError, "inventory"):
            artifact.pack(self.site, self.archive, COMMIT)
        extra.unlink()
        extra.symlink_to(path)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            artifact.pack(self.site, self.archive, COMMIT)

    def test_existing_output_is_not_modified(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("existing")
        with self.assertRaises(FileExistsError):
            artifact.unpack(self.archive, self.output, COMMIT)
        self.assertEqual(marker.read_text(), "existing")

    def test_download_waits_for_exact_commit_and_only_404_allows_a_new_build(self):
        artifact.pack(self.site, self.archive, COMMIT)
        data = self.archive.read_bytes()
        responses = [404, 200]
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                status = responses.pop(0)
                self.send_response(status)
                self.end_headers()
                if status == 200:
                    self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(artifact, "RELEASE_BASE", f"http://127.0.0.1:{server.server_port}"), \
                 patch.object(artifact.time, "sleep"):
                self.assertEqual(artifact.restore(COMMIT, self.output, 10), 0)
                self.assertEqual(paths, [f"/site-{COMMIT}/{artifact.ARCHIVE_NAME}"] * 2)
                responses[:] = [404]
                self.assertEqual(artifact.restore(COMMIT, self.root / "missing", 0, True), 3)
                responses[:] = [403]
                with self.assertRaises(artifact.HTTPError):
                    artifact.restore(COMMIT, self.root / "forbidden", 0, True)
                responses[:] = [503]
                with self.assertRaisesRegex(RuntimeError, "Complete the GitHub Pages workflow"):
                    artifact.restore(COMMIT, self.root / "unavailable", 0, True)
                responses[:] = [404]
                with self.assertRaisesRegex(RuntimeError, "retry the RTD build"):
                    artifact.restore(COMMIT, self.root / "timeout", 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_workflows_share_the_artifact_instead_of_rebuilding_on_rtd(self):
        root = Path(__file__).resolve().parent.parent
        rtd = (root / ".readthedocs.yaml").read_text()
        pages = (root / ".github/workflows/deploy-github-pages.yml").read_text()
        self.assertIn("deployment-artifact.py restore", rtd)
        self.assertNotIn("./build.sh", rtd)
        self.assertIn("deployment-artifact.py restore", pages)
        self.assertIn("deployment-artifact.py pack", pages)
        self.assertLess(pages.index("gh release create"), pages.index("Upload Pages artifact"))
        restore_script = textwrap.dedent(
            pages.split("id: artifact\n", 1)[1].split("run: |\n", 1)[1].split("\n\n", 1)[0]
        )
        for status, expected, output in [(0, 0, "restored=true\n"), (3, 0, "restored=false\n"), (1, 1, "")]:
            with self.subTest(status=status):
                result_file = self.root / "github-output"
                result_file.write_text("")
                result = subprocess.run(
                    ["bash", "-c", 'python3() { return "$MOCK_STATUS"; }\n' + restore_script],
                    env={**os.environ, "MOCK_STATUS": str(status), "GITHUB_OUTPUT": str(result_file)},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(result_file.read_text(), output)


if __name__ == "__main__":
    unittest.main()
