"""Mirror a completed GitHub desktop release to R2; publish the stable feed last."""

import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen

CONFIG = Path(__file__).with_name("desktop-downloads.json")
PLATFORMS = {"darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-aarch64", "windows-x86_64"}


def github(repo, resource):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/{resource}"], text=True))


def prepare_manifest(release, directory, public_url):
    tag = release["tag_name"]
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?", tag):
        raise ValueError("Invalid release tag")
    if release["draft"]:
        raise ValueError("Cannot publish a draft release")
    assets = release["assets"]
    names = [asset["name"] for asset in assets]
    if len(names) != len(set(names)) or "latest.json" not in names:
        raise ValueError("Release needs unique asset names and latest.json")
    for asset in assets:
        name = asset["name"]
        if Path(name).name != name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("Unsafe release asset name")
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != asset["size"]:
            raise ValueError(f"Missing or incomplete release asset: {name}")
    manifest = json.loads((directory / "latest.json").read_text())
    if manifest["version"].removeprefix("v") != tag.removeprefix("v"):
        raise ValueError("Manifest version does not match release")
    if not PLATFORMS <= manifest["platforms"].keys():
        raise ValueError("Updater manifest is missing a supported platform")
    by_url = {url: asset for asset in assets for url in (asset["url"], asset["browser_download_url"])}
    for entry in manifest["platforms"].values():
        asset = by_url.get(entry["url"])
        if not asset or asset["name"] == "latest.json":
            raise ValueError("Updater URL does not match a release asset")
        signature = directory / (asset["name"] + ".sig")
        if not entry.get("signature") or not signature.is_file() or signature.read_text().strip() != entry["signature"].strip():
            raise ValueError(f"Missing or mismatched signature: {asset['name']}")
        entry["url"] = f"{public_url.rstrip('/')}/releases/{quote(tag, safe='')}/{quote(asset['name'], safe='')}"
    return manifest


def upload(config, path, key, cache_control):
    subprocess.run([
        "aws", "s3", "cp", str(path), f"s3://{config['bucket']}/{key}",
        "--endpoint-url", config["endpoint"], "--region", config["region"],
        "--cache-control", cache_control, "--content-type",
        "application/json" if key.endswith(".json") else (mimetypes.guess_type(path.name)[0] or "application/octet-stream"),
        "--only-show-errors",
    ], check=True)


def verify_public(url, size):
    with urlopen(Request(url, method="HEAD", headers={"User-Agent": "Flies-Release-Publisher/1.0"}), timeout=60) as response:
        if response.status != 200 or int(response.headers.get("Content-Length", -1)) != size:
            raise ValueError("Public download is missing or has the wrong size")


def publish(release, directory, config, current_latest_id, put=upload, verify=verify_public):
    manifest = prepare_manifest(release, directory, config["publicUrl"])
    prefix = f"releases/{release['tag_name']}/"
    # Publish and verify every binary/signature before exposing an updater manifest.
    for asset in release["assets"]:
        if asset["name"] == "latest.json":
            continue
        key = prefix + asset["name"]
        put(config, directory / asset["name"], key, "public, max-age=31536000, immutable")
        verify(config["publicUrl"].rstrip("/") + "/" + quote(key, safe="/"), asset["size"])
    output = directory / "r2-latest.json"
    output.write_text(json.dumps(manifest, indent=2) + "\n")
    put(config, output, prefix + "latest.json", "no-cache, max-age=0, must-revalidate")
    # Resolve latest immediately before promotion: an older rerun cannot roll back clients.
    if not release["prerelease"] and current_latest_id() == release["id"]:
        put(config, output, "latest.json", "no-cache, max-age=0, must-revalidate")
        print(f"Published stable updater {release['tag_name']}")
    else:
        print(f"Mirrored {release['tag_name']}; stable updater unchanged")
    return manifest


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/publish-desktop-update.py <release-tag>")
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        if not os.environ.get(name):
            raise SystemExit(f"Missing {name}")
    repo = os.environ.get("GITHUB_REPOSITORY", "lassejlv/flies")
    tag = sys.argv[1]
    release = github(repo, "releases/tags/" + quote(tag, safe=""))
    config = json.loads(CONFIG.read_text())
    with tempfile.TemporaryDirectory(prefix="flies-release-") as temporary:
        directory = Path(temporary)
        subprocess.run(["gh", "release", "download", tag, "--repo", repo, "--dir", temporary], check=True)
        publish(release, directory, config, lambda: github(repo, "releases/latest")["id"])


if __name__ == "__main__":
    main()
