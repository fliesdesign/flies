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
        names = {
            "darwin-aarch64": "Flies_1.2.3_aarch64.app.tar.gz",
            "darwin-x86_64": "Flies_1.2.3_x64.app.tar.gz",
            "linux-x86_64": "Flies_1.2.3_amd64.AppImage",
            "windows-aarch64": "Flies_1.2.3_arm64-setup.exe",
            "windows-x86_64": "Flies_1.2.3_x64-setup.exe",
        }
        for index, platform in enumerate(sorted(publisher.PLATFORMS)):
            name = names[platform]
            self.asset(name, b"signed-binary", str(index))
            self.asset(name + ".sig", b"signature\n", "sig" + str(index))

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
        self.assertEqual(manifest["version"], "1.2.3")
        windows = manifest["platforms"]["windows-x86_64"]
        self.assertEqual(windows["signature"], "signature")
        self.assertEqual(windows["url"], manifest["platforms"]["windows-x86_64-nsis"]["url"])
        self.assertEqual(
            windows["url"],
            "https://desktop.flies.design/releases/v1.2.3/Flies_1.2.3_x64-setup.exe",
        )
        self.assertEqual(
            manifest["platforms"]["darwin-aarch64"]["url"],
            manifest["platforms"]["darwin-aarch64-app"]["url"],
        )
        self.assertNotIn("windows-x86_64-msi", manifest["platforms"])

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

    def test_empty_signature_rejects(self):
        signature = next(asset for asset in self.release["assets"] if asset["name"].endswith(".sig"))
        (self.directory / signature["name"]).write_text("")
        signature["size"] = 0
        with self.assertRaisesRegex(ValueError, "signature"):
            self.run_publish()

    def test_incomplete_platform_matrix_rejects(self):
        self.release["assets"] = [
            asset for asset in self.release["assets"] if "arm64-setup" not in asset["name"]
        ]
        with self.assertRaisesRegex(ValueError, "missing a supported platform"):
            self.run_publish()

    def test_partial_release_manifest_is_ignored(self):
        partial = json.dumps({
            "version": "9.9.9",
            "platforms": {"windows-x86_64": {"url": "https://example.invalid/setup.exe", "signature": "nope"}},
        }).encode()
        self.asset("latest.json", partial, "manifest")
        manifest = publisher.prepare_manifest(self.release, self.directory, self.config["publicUrl"])
        self.assertEqual(manifest["version"], "1.2.3")
        self.assertIn("darwin-aarch64", manifest["platforms"])
        self.assertEqual(manifest["platforms"]["linux-x86_64"]["signature"], "signature")
        self.assertNotIn("example.invalid", manifest["platforms"]["windows-x86_64"]["url"])

    def test_windows_msi_is_an_additional_updater_entry(self):
        self.asset("Flies_1.2.3_x64_en-US.msi", b"msi-bytes", "msi")
        self.asset("Flies_1.2.3_x64_en-US.msi.sig", b"msi-signature\n", "msi-sig")
        manifest = publisher.prepare_manifest(self.release, self.directory, self.config["publicUrl"])
        self.assertTrue(manifest["platforms"]["windows-x86_64"]["url"].endswith("x64-setup.exe"))
        self.assertTrue(manifest["platforms"]["windows-x86_64-msi"]["url"].endswith("x64_en-US.msi"))
        self.assertEqual(manifest["platforms"]["windows-x86_64-msi"]["signature"], "msi-signature")


if __name__ == "__main__":
    unittest.main()
