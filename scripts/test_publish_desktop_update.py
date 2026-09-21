import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-desktop-update.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = {"publicUrl": "https://desktop.flies.design/"}
        self.release = {"id": 42, "tag_name": "v1.2.3", "draft": False, "prerelease": False, "assets": []}
        platforms = {}
        for index, platform in enumerate(sorted(publisher.PLATFORMS)):
            name = f"Flies {platform}.bin"
            asset = self.asset(name, b"signed-binary", str(index))
            self.asset(name + ".sig", b"signature\n", "sig" + str(index))
            platforms[platform] = {"url": asset["url"], "signature": "signature"}
        self.asset("latest.json", json.dumps({"version": "1.2.3", "platforms": platforms}).encode(), "manifest")

    def asset(self, name, contents, identifier):
        (self.directory / name).write_bytes(contents)
        asset = {"name": name, "size": len(contents), "url": f"https://api.github.com/repos/example/app/releases/assets/{identifier}", "browser_download_url": f"https://github.com/example/app/releases/download/v1.2.3/{name}"}
        self.release["assets"].append(asset)
        return asset

    def run_publish(self, latest=42, fail=False):
        events = []
        def put(config, path, key, cache):
            events.append(("upload", key, cache))
        def verify(url, size):
            events.append(("verify", url))
            if fail:
                raise ValueError("download unavailable")
        publisher.publish(self.release, self.directory, self.config, lambda: latest, put, verify)
        return events

    def test_rewrites_api_urls_and_preserves_signatures(self):
        manifest = publisher.prepare_manifest(self.release, self.directory, self.config["publicUrl"])
        for platform, entry in manifest["platforms"].items():
            self.assertEqual(entry["url"], f"https://desktop.flies.design/releases/v1.2.3/Flies%20{platform}.bin")
            self.assertEqual(entry["signature"], "signature")

    def test_stable_manifest_published_last_after_every_download(self):
        events = self.run_publish()
        self.assertEqual(events[-1], ("upload", "latest.json", "no-cache, max-age=0, must-revalidate"))
        self.assertEqual(events[-2][1], "releases/v1.2.3/latest.json")
        self.assertEqual(len([event for event in events if event[0] == "verify"]), 10)

    def test_prerelease_and_old_release_never_replace_stable(self):
        self.assertNotIn("latest.json", [event[1] for event in self.run_publish(latest=99)])
        self.release["prerelease"] = True
        self.assertNotIn("latest.json", [event[1] for event in self.run_publish()])

    def test_failed_upload_verification_prevents_manifest_publication(self):
        with self.assertRaisesRegex(ValueError, "download unavailable"):
            self.run_publish(fail=True)
        self.assertFalse((self.directory / "r2-latest.json").exists())

    def test_missing_binary_rejects_before_upload(self):
        (self.directory / self.release["assets"][0]["name"]).unlink()
        with self.assertRaisesRegex(ValueError, "Missing or incomplete"):
            self.run_publish()

    def test_signature_mismatch_rejects(self):
        (self.directory / self.release["assets"][1]["name"]).write_text("bad-sign!\n")
        with self.assertRaises(ValueError):
            self.run_publish()

    def test_incomplete_platform_matrix_rejects(self):
        path = self.directory / "latest.json"
        manifest = json.loads(path.read_text())
        manifest["platforms"].pop("windows-aarch64")
        path.write_text(json.dumps(manifest))
        self.release["assets"][-1]["size"] = path.stat().st_size
        with self.assertRaisesRegex(ValueError, "missing a supported platform"):
            self.run_publish()


if __name__ == "__main__":
    unittest.main()
