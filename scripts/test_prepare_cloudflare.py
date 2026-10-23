import gzip
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("prepare_cloudflare", Path(__file__).with_name("prepare-cloudflare.py"))
cloudflare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cloudflare)
HEADERS = Path(__file__).resolve().parent.parent / "cloudflare" / "_headers"


class PrepareCloudflareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.site = self.root / "dist"
        (self.site / "xeus").mkdir(parents=True)
        (self.site / "deployment.json").write_text("{}")
        (self.site / "lab").mkdir()
        (self.site / "lab/index.html").write_text("<html></html>")
        self.large = b"WASM" * 100
        (self.site / "xeus/big.so.asm").write_bytes(self.large)

    def prepare(self, name="pages"):
        with patch.object(cloudflare, "MAX_FILE_BYTES", 100):
            return cloudflare.prepare(self.site, self.root / name, HEADERS)

    def test_oversized_assets_are_gzipped_with_matching_header_rules(self):
        result = self.prepare()
        pages = self.root / "pages"
        self.assertEqual(result["compressed"], 1)
        self.assertEqual(gzip.decompress((pages / "xeus/big.so.asm").read_bytes()), self.large)
        headers = (pages / "_headers").read_text()
        self.assertIn("\n/xeus/big.so.asm\n  Content-Encoding: gzip\n", headers)
        self.assertIn("Cross-Origin-Embedder-Policy: require-corp", headers)
        self.assertEqual((self.site / "xeus/big.so.asm").read_bytes(), self.large, "the source site is untouched")
        self.assertFalse((self.site / "_headers").exists())

    def test_in_place_preparation_for_cloudflare_git_builds(self):
        with patch.object(cloudflare, "MAX_FILE_BYTES", 100):
            result = cloudflare.prepare(self.site, None, HEADERS)
        self.assertEqual(result["directory"], self.site.resolve())
        self.assertEqual(gzip.decompress((self.site / "xeus/big.so.asm").read_bytes()), self.large)
        self.assertTrue((self.site / "_headers").is_file())

    def test_limits_are_checked_before_upload(self):
        with patch.object(cloudflare, "MAX_FILES", 2), self.assertRaisesRegex(ValueError, "files"):
            self.prepare("files")
        with patch.object(cloudflare, "MAX_HEADER_RULES", 1), self.assertRaisesRegex(ValueError, "header rules"):
            self.prepare("rules")
        (self.site / "xeus/hard:*.bin").write_bytes(b"x" * 500)
        with self.assertRaisesRegex(ValueError, "literal"):
            self.prepare("literal")

    def test_missing_manifest_or_existing_output_is_rejected(self):
        (self.root / "taken").mkdir()
        with self.assertRaises(FileExistsError):
            self.prepare("taken")
        (self.site / "deployment.json").unlink()
        with self.assertRaisesRegex(ValueError, "deployment.json"):
            self.prepare("manifest")

    def test_real_headers_file_has_room_for_compressed_assets(self):
        rules = [line for line in HEADERS.read_text().splitlines() if line.startswith("/")]
        self.assertEqual(rules, ["/*"])


if __name__ == "__main__":
    unittest.main()
