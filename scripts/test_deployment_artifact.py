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
        # Keep restore() tests offline; tests that exercise the publish-status check override this.
        api = patch.object(artifact, "GITHUB_API_BASE", "http://127.0.0.1:9")
        api.start()
        self.addCleanup(api.stop)
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
                responses[:] = [503] * (artifact.TRANSIENT_RETRIES + 1)
                with self.assertRaisesRegex(RuntimeError, "Complete the GitHub Pages workflow"):
                    artifact.restore(COMMIT, self.root / "unavailable", 0, True)
                responses[:] = [404]
                with self.assertRaisesRegex(RuntimeError, "retry the RTD build"):
                    artifact.restore(COMMIT, self.root / "timeout", 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_a_failed_pages_publish_stops_waiting_for_the_artifact(self):
        runs = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith(f"/actions/runs?head_sha={COMMIT}"):
                    body = json.dumps({"workflow_runs": runs}).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, *args):
                pass

        def run(status, conclusion, run_id=1, path=artifact.PAGES_WORKFLOW_PATH):
            return {"id": run_id, "path": path, "status": status, "conclusion": conclusion}

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with patch.object(artifact, "RELEASE_BASE", base), \
                 patch.object(artifact, "GITHUB_API_BASE", base), \
                 patch.object(artifact.time, "sleep") as sleep:
                runs[:] = [run("completed", "failure"), run("completed", "success", 2, ".github/workflows/other.yml")]
                self.assertTrue(artifact.pages_publish_failed(COMMIT))
                runs[:] = [run("completed", "failure", 1), run("in_progress", None, 3)]
                self.assertFalse(artifact.pages_publish_failed(COMMIT))
                runs[:] = [run("completed", "failure", 1), run("completed", "success", 3)]
                self.assertFalse(artifact.pages_publish_failed(COMMIT))
                runs[:] = []
                self.assertFalse(artifact.pages_publish_failed(COMMIT))
                runs[:] = [run("completed", "failure")]
                self.assertEqual(artifact.restore(COMMIT, self.root / "failed", 900, True), 3)
                with self.assertRaisesRegex(RuntimeError, "GitHub Pages publish failed"):
                    artifact.restore(COMMIT, self.root / "failed-strict", 900)
                sleep.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_short_outages_are_retried_without_waiting_for_a_release(self):
        artifact.pack(self.site, self.archive, COMMIT)
        data = self.archive.read_bytes()
        responses = [503, 502]
        sleeps = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                status = responses.pop(0) if responses else 200
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
                 patch.object(artifact.time, "sleep", sleeps.append):
                self.assertEqual(artifact.restore(COMMIT, self.output, 0, True), 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(len(sleeps), 2)

    def test_truncated_download_is_retried_instead_of_failing_the_build(self):
        artifact.pack(self.site, self.archive, COMMIT)
        data = self.archive.read_bytes()
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                body = data[: len(data) // 2] if len(requests) == 1 else data
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(artifact, "RELEASE_BASE", f"http://127.0.0.1:{server.server_port}"), \
                 patch.object(artifact.time, "sleep"):
                self.assertEqual(artifact.restore(COMMIT, self.output, 0), 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(len(requests), 2)
        self.assertTrue((self.output / "deployment.json").is_file())

    def test_force_replaces_a_stale_output_only_after_a_verified_restore(self):
        artifact.pack(self.site, self.archive, COMMIT)
        self.output.mkdir()
        (self.output / "stale").write_text("old")
        artifact.unpack(self.archive, self.output, COMMIT, force=True)
        self.assertFalse((self.output / "stale").exists())
        self.assertTrue((self.output / "lab/index.html").is_file())

        (self.output / "stale").write_text("old")
        self.make_archive(self.valid_entries()[:-1])
        with self.assertRaises(ValueError):
            artifact.unpack(self.archive, self.output, COMMIT, force=True)
        self.assertEqual((self.output / "stale").read_text(), "old")

    def test_commit_resolution_supports_hosts_without_a_git_checkout(self):
        other = "b" * 40
        self.assertEqual(artifact.resolve_commit(other, {}), other)
        with patch.object(artifact.subprocess, "check_output", side_effect=FileNotFoundError):
            self.assertEqual(artifact.resolve_commit(None, {"VERCEL_GIT_COMMIT_SHA": COMMIT.upper()}), COMMIT)
            self.assertEqual(artifact.resolve_commit(None, {"CF_PAGES_COMMIT_SHA": other}), other)
            with self.assertRaisesRegex(ValueError, "VERCEL_GIT_COMMIT_SHA"):
                artifact.resolve_commit(None, {})
        with patch.object(artifact.subprocess, "check_output", return_value=other + "\n"):
            self.assertEqual(artifact.resolve_commit(None, {"GITHUB_SHA": COMMIT}), other)

    def test_publish_removes_incomplete_drafts_and_tolerates_a_concurrent_publisher(self):
        calls = []

        def fake_gh(*args, capture=False):
            calls.append(args)
            if args[:2] == ("release", "list"):
                return json.dumps([{"tagName": f"site-{COMMIT}", "isDraft": True}])
            if args[:2] == ("release", "create") and fail_create:
                raise artifact.subprocess.CalledProcessError(1, "gh")
            return ""

        fail_create = False
        with patch.object(artifact, "gh", fake_gh):
            self.assertEqual(artifact.publish(self.site, COMMIT), 0)
        verbs = [call[:2] for call in calls]
        self.assertEqual(verbs, [("release", "list"), ("release", "delete"), ("release", "create"), ("release", "edit")])
        create = next(call for call in calls if call[:2] == ("release", "create"))
        self.assertIn("--draft", create)
        self.assertEqual(calls[-1][3:], ("--draft=false", "--latest=false"))

        calls.clear()
        fail_create = True
        with patch.object(artifact, "gh", fake_gh), patch.object(artifact, "release_is_public", return_value=True):
            self.assertEqual(artifact.publish(self.site, COMMIT), 0)
        with patch.object(artifact, "gh", fake_gh), patch.object(artifact, "release_is_public", return_value=False):
            with self.assertRaises(artifact.subprocess.CalledProcessError):
                artifact.publish(self.site, COMMIT)

    def test_publish_never_replaces_a_published_release(self):
        calls = []

        def fake_gh(*args, capture=False):
            calls.append(args[:2])
            return json.dumps([{"tagName": f"site-{COMMIT}", "isDraft": False}])

        with patch.object(artifact, "gh", fake_gh):
            self.assertEqual(artifact.publish(self.site, COMMIT), 0)
        self.assertEqual(calls, [("release", "list")])

    def test_workflows_share_the_artifact_instead_of_rebuilding_on_rtd(self):
        root = Path(__file__).resolve().parent.parent
        rtd = (root / ".readthedocs.yaml").read_text()
        pages = (root / ".github/workflows/deploy-github-pages.yml").read_text()
        cloudflare = (root / ".github/workflows/deploy-cloudflare.yml").read_text()
        action = (root / ".github/actions/prepare-site/action.yml").read_text()
        self.assertIn("deployment-artifact.py restore", rtd)
        self.assertNotIn("./build.sh", rtd)
        self.assertIn("deployment-artifact.py restore", action)
        self.assertIn("deployment-artifact.py publish", action)
        # Every GitHub-hosted mirror must serve the canonical bytes, not an independent rebuild.
        for workflow in (pages, cloudflare):
            self.assertIn("uses: ./.github/actions/prepare-site", workflow)
            self.assertNotIn("build.sh", workflow)
        self.assertLess(action.index("Verify deployment and record release"), action.index("deployment-artifact.py publish"))
        self.assertLess(pages.index("prepare-site"), pages.index("Upload Pages artifact"))
        restore_script = textwrap.dedent(
            action.split("id: artifact\n", 1)[1].split("run: |\n", 1)[1].split("\n\n", 1)[0]
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


class PlatformBuildTests(unittest.TestCase):
    """scripts/platform-build.sh: reuse the canonical artifact on Vercel and Cloudflare, else build."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        scripts = self.root / "scripts"
        scripts.mkdir()
        source = Path(__file__).resolve().parent
        (scripts / "platform-build.sh").write_text((source / "platform-build.sh").read_text())
        (scripts / "deployment-artifact.py").write_text(
            "import os, sys\n"
            "from pathlib import Path\n"
            "print('restore', os.environ.get('DATAX_ARTIFACT_WAIT_SECONDS'), *sys.argv[1:])\n"
            "if os.environ['MOCK_RESTORE'] == '0':\n"
            "    Path('dist').mkdir(exist_ok=True)\n"
            "    Path('dist/deployment.json').write_text('{}')\n"
            "sys.exit(int(os.environ['MOCK_RESTORE']))\n"
        )
        (scripts / "prepare-cloudflare.py").write_text("print('prepare-cloudflare')\n")
        (scripts / "pwa.cjs").write_text("console.log('pwa verified');\n")
        (self.root / "build.sh").write_text(
            "#!/bin/bash\necho independent build\nmkdir -p dist\necho '{}' > dist/deployment.json\n"
        )

    def run_build(self, restore_status, **env):
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("VERCEL", "CF_PAGES", "DATAX_"))
        }
        environment.update(MOCK_RESTORE=str(restore_status), **env)
        return subprocess.run(
            ["bash", str(self.root / "scripts/platform-build.sh")], cwd=self.root, env=environment,
            capture_output=True, text=True,
        )

    def test_a_published_artifact_is_reused_without_building(self):
        result = self.run_build(0, VERCEL="1", VERCEL_ENV="production")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("restore 900 restore --force --allow-missing", result.stdout)
        self.assertNotIn("independent build", result.stdout)
        self.assertIn("pwa verified", result.stdout)

    def test_previews_do_not_wait_and_fall_back_to_an_independent_build(self):
        result = self.run_build(3, VERCEL="1", VERCEL_ENV="preview")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("restore 0 restore", result.stdout)
        self.assertIn("independent build", result.stdout)

    def test_any_restore_failure_falls_back_unless_artifact_only(self):
        self.assertIn("independent build", self.run_build(1, VERCEL="1").stdout)
        strict = self.run_build(1, VERCEL="1", DATAX_ARTIFACT_ONLY="1")
        self.assertEqual(strict.returncode, 1)
        self.assertNotIn("independent build", strict.stdout)

    def test_wait_can_be_overridden_and_cloudflare_builds_are_prepared_in_place(self):
        result = self.run_build(0, CF_PAGES="1", CF_PAGES_BRANCH="main", DATAX_ARTIFACT_WAIT_SECONDS="30")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("restore 30 restore", result.stdout)
        self.assertIn("prepare-cloudflare", result.stdout)
        self.assertNotIn("prepare-cloudflare", self.run_build(0, VERCEL="1").stdout)


if __name__ == "__main__":
    unittest.main()
