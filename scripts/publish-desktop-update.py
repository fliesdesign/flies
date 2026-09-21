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
# Suffix is the updater bundle Tauri produced. The alias is the installer-specific key
# newer updater plugins request; it points at the same signed asset.
UPDATERS = (
    ("darwin-aarch64", "_aarch64.app.tar.gz", "darwin-aarch64-app"),
    ("darwin-x86_64", "_x64.app.tar.gz", "darwin-x86_64-app"),
    ("linux-x86_64", "_amd64.AppImage", "linux-x86_64-appimage"),
    ("windows-aarch64", "_arm64-setup.exe", "windows-aarch64-nsis"),
    ("windows-x86_64", "_x64-setup.exe", "windows-x86_64-nsis"),
)
PLATFORMS = {platform for platform, _, _ in UPDATERS}


def github(repo, resource):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/{resource}"], text=True))


def updater_asset(assets, suffix):
    names = {asset["name"] for asset in assets}
    matches = [
        asset for asset in assets
        if asset["name"].endswith(suffix) and f"{asset['name']}.sig" in names
    ]
    if len(matches) != 1:
        raise ValueError("Updater manifest is missing a supported platform")
    return matches[0]


def signed_entry(directory, asset, public_url, tag):
    signature_path = directory / (asset["name"] + ".sig")
    signature = signature_path.read_text().strip() if signature_path.is_file() else ""
    if not signature:
        raise ValueError(f"Missing or mismatched signature: {asset['name']}")
    base = public_url.rstrip("/")
    name = quote(asset["name"], safe="")
    return {
        "signature": signature,
        "url": f"{base}/releases/{quote(tag, safe='')}/{name}",
    }


def prepare_manifest(release, directory, public_url):
    tag = release["tag_name"]
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?", tag):
        raise ValueError("Invalid release tag")
    if release["draft"]:
        raise ValueError("Cannot publish a draft release")
    assets = release["assets"]
    names = [asset["name"] for asset in assets]
    if len(names) != len(set(names)):
        raise ValueError("Release needs unique asset names")
    for asset in assets:
        name = asset["name"]
        if Path(name).name != name or name in (".", "..") or "/" in name or "\\" in name:
            raise ValueError("Unsafe release asset name")
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != asset["size"]:
            raise ValueError(f"Missing or incomplete release asset: {name}")
    # Build the feed from signed bundles. A latest.json uploaded by one matrix job
    # only contains that job's platform, so it cannot be the source of truth.
    platforms = {}
    for platform, suffix, alias in UPDATERS:
        entry = signed_entry(directory, updater_asset(assets, suffix), public_url, tag)
        platforms[platform] = entry
        platforms[alias] = dict(entry)
    msi = [
        asset for asset in assets
        if asset["name"].endswith(".msi") and "_x64_" in asset["name"] and f"{asset['name']}.sig" in names
    ]
    if len(msi) > 1:
        raise ValueError("Release has more than one Windows x64 MSI")
    if msi:
        platforms["windows-x86_64-msi"] = signed_entry(directory, msi[0], public_url, tag)
    return {
        "version": tag.removeprefix("v"),
        "notes": release.get("body") or "",
        "pub_date": release.get("published_at") or "",
        "platforms": platforms,
    }


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
