#!/usr/bin/env python3
"""Build a local arm64 macOS app without embedding mutable or private data."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Study Studio.app"
BUNDLE_ID = "com.waylon.studystudio"
MACHO_MAGICS = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def run(*args: str | Path, capture: bool = False) -> str:
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ""


def allowed(values: list[str] | None, target: str) -> bool:
    if not values:
        return True
    if f"!{target}" in values:
        return False
    positives = [value for value in values if not value.startswith("!")]
    return not positives or target in positives or "any" in positives


def assert_internal_links(directory: Path, allowed_root: Path) -> None:
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            candidate = Path(parent) / name
            if candidate.is_symlink() and not candidate.resolve(strict=True).is_relative_to(allowed_root):
                raise RuntimeError(f"Dependency symlink leaves node_modules: {candidate}")


def copy_production_dependencies(destination: Path) -> int:
    lock = json.loads((ROOT / "package-lock.json").read_text())
    installed_root = (ROOT / "node_modules").resolve(strict=True)
    count = 0
    for relative, entry in sorted(lock["packages"].items(), key=lambda item: (item[0].count("/"), item[0])):
        if not relative or entry.get("dev") or not allowed(entry.get("os"), "darwin") or not allowed(entry.get("cpu"), "arm64"):
            continue
        if not relative.startswith("node_modules/") or ".." in Path(relative).parts or entry.get("link"):
            raise RuntimeError(f"Unsupported production dependency location: {relative}")
        source = ROOT / relative
        if not source.exists():
            if entry.get("optional"):
                continue
            raise RuntimeError(f"Production dependency is not installed: {relative}")
        if not source.resolve(strict=True).is_relative_to(installed_root):
            raise RuntimeError(f"Dependency leaves node_modules: {relative}")
        assert_internal_links(source, installed_root)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc", ".git"))
        count += 1
    return count


def make_icon(destination: Path, scratch: Path) -> None:
    source = ROOT / "native/Assets/AppIcon.png"
    if not source.is_file():
        raise RuntimeError("Missing native/Assets/AppIcon.png")
    iconset = scratch / "AppIcon.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            pixels = str(size * scale)
            run("/usr/bin/sips", "-s", "format", "png", "--resampleHeightWidth", pixels, pixels,
                source, "--out", iconset / f"icon_{size}x{size}{suffix}.png", capture=True)
    run("/usr/bin/iconutil", "--convert", "icns", "--output", destination, iconset)


def resolve_node() -> Path:
    configured = os.environ.get("STUDY_NODE_BINARY")
    if configured:
        return Path(configured).expanduser().resolve()
    installed = Path("/Applications/Study Studio.app/Contents/Resources/runtime/node")
    if installed.is_file():
        return installed.resolve()
    available = shutil.which("node")
    if available:
        return Path(available).resolve()
    raise RuntimeError("Standalone Node is unavailable; set STUDY_NODE_BINARY to a standalone arm64 Node binary.")


def validate_runtime(node: Path) -> str:
    if not node.is_file():
        raise RuntimeError("Standalone Node is unavailable; set STUDY_NODE_BINARY to a standalone arm64 Node binary.")
    linked = run("/usr/bin/otool", "-L", node, capture=True).splitlines()[1:]
    for line in linked:
        dependency = line.strip().split(" (", 1)[0]
        if not dependency.startswith(("/System/Library/", "/usr/lib/")):
            raise RuntimeError(f"Node depends on an external library: {dependency}")
    description = run("/usr/bin/file", node, capture=True)
    if "arm64" not in description:
        raise RuntimeError("The bundled Node binary must support arm64.")
    return run(node, "--version", capture=True)


def sign_bundle(bundle: Path) -> None:
    runtime = bundle / "Contents/Resources/runtime/node"
    entitlements = ROOT / "native/entitlements.plist"
    candidates = []
    for candidate in bundle.rglob("*"):
        if candidate.is_file():
            with candidate.open("rb") as handle:
                if handle.read(4) in MACHO_MAGICS:
                    candidates.append(candidate)
    for candidate in candidates:
        command = ["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none"]
        if candidate == runtime:
            command += ["--entitlements", str(entitlements)]
        run(*command, candidate)
    run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", bundle)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", bundle)


def native_sources() -> dict[str, str]:
    files = [ROOT / "native/Package.swift", ROOT / "native/entitlements.plist"]
    files += sorted(p for p in (ROOT / "native/Sources").rglob("*") if p.is_file())
    if len(files) < 3 or any(not p.is_file() or p.is_symlink() for p in files):
        raise RuntimeError("The native source fingerprint is incomplete.")
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def native_code_fingerprint(binary: Path) -> str:
    """Hash all executable bytes after removing only the variable code signature.

    Outer bundle signing rewrites the executable's resource seal. Normalize a
    private copy, never the installed executable, so that seal changes do not
    invalidate reuse while changes to executable code or data still do.
    """
    with tempfile.TemporaryDirectory(prefix="study-native-fingerprint-") as temporary:
        unsigned = Path(temporary) / "StudyStudioApp"
        shutil.copy2(binary, unsigned)
        run("/usr/bin/codesign", "--remove-signature", unsigned, capture=True)
        return hashlib.sha256(unsigned.read_bytes()).hexdigest()


def reusable_native(bundle: Path, sources: dict[str, str]) -> Path | None:
    """Reuse only a signed executable paired with these exact native inputs."""
    if not bundle.exists():
        return None
    if bundle.is_symlink():
        raise RuntimeError("The installed app is a symbolic link.")
    manifest = bundle / "Contents/Resources/NativeBuild.json"
    if not manifest.is_file():
        return None
    try:
        recorded = json.loads(manifest.read_text())
        info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
        binary = bundle / "Contents/MacOS/StudyStudioApp"
        if info.get("CFBundleIdentifier") != BUNDLE_ID or recorded.get("schemaVersion") != 2 or recorded.get("sources") != sources:
            return None
        if binary.is_symlink():
            return None
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", bundle)
        if native_code_fingerprint(binary) != recorded.get("unsignedBinarySHA256"):
            return None
        return binary
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reuse-installed-native", action="store_true", help="Reuse the signed installed shell only when its recorded native inputs match exactly.")
    parser.add_argument("--output", type=Path, default=ROOT / "build/macos", help="Directory for the resulting .app.")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("This local package target requires Apple silicon macOS.")
    node = resolve_node()
    node_version = validate_runtime(node)
    if not (ROOT / "dist/index.html").is_file():
        raise RuntimeError("The web frontend is not built. Build it once before packaging.")
    sources = native_sources()
    binary = reusable_native(Path("/Applications/Study Studio.app"), sources) if args.reuse_installed_native else None
    reused = binary is not None
    if binary is None:
        run("/usr/bin/swift", "build", "--package-path", ROOT / "native", "-c", "release")
        bin_path = run("/usr/bin/swift", "build", "--package-path", ROOT / "native", "-c", "release", "--show-bin-path", capture=True)
        binary = Path(bin_path) / "StudyStudioApp"
        if not binary.is_file():
            raise RuntimeError("Native release executable is missing.")
    if native_sources() != sources:
        raise RuntimeError("Native sources changed while packaging; rebuild before installing.")
    output = args.output.expanduser().resolve()
    if output / APP_NAME == Path("/Applications/Study Studio.app"):
        raise RuntimeError("Use script/install_macos.py to replace the installed app safely.")
    output.mkdir(parents=True, exist_ok=True)
    final = output / APP_NAME
    with tempfile.TemporaryDirectory(prefix=".study-studio-package-", dir=output) as temporary:
        scratch = Path(temporary)
        bundle = scratch / APP_NAME
        contents = bundle / "Contents"
        resources = contents / "Resources"
        app = resources / "app"
        (contents / "MacOS").mkdir(parents=True)
        (resources / "runtime").mkdir(parents=True)
        app.mkdir()
        shutil.copy2(binary, contents / "MacOS/StudyStudioApp")
        shutil.copy2(node, resources / "runtime/node")
        for name in ("server", "shared", "dist"):
            shutil.copytree(ROOT / name, app / name,
                            ignore=shutil.ignore_patterns(".DS_Store", "__pycache__", "*.pyc", ".git"))
        shutil.copy2(ROOT / "package.json", app / "package.json")
        dependency_count = copy_production_dependencies(app)
        # No symlink in the finished bundle may point back into the source checkout.
        for candidate in bundle.rglob("*"):
            if candidate.is_symlink():
                raise RuntimeError(f"Unexpected symlink in package: {candidate}")
        plist = plistlib.loads((ROOT / "native/Info.plist").read_bytes())
        version = json.loads((ROOT / "package.json").read_text())["version"]
        if plist["CFBundleShortVersionString"] != version:
            raise RuntimeError("Native and web package versions differ.")
        (contents / "Info.plist").write_bytes(plistlib.dumps(plist))
        make_icon(resources / "AppIcon.icns", scratch)
        info = {"version": version, "node": node_version, "architecture": "arm64",
                "productionPackages": dependency_count,
                "sourceNodeSHA256": hashlib.sha256(node.read_bytes()).hexdigest()}
        (resources / "RuntimeInfo.json").write_text(json.dumps(info, indent=2) + "\n")
        for license_name in ("LICENSE", "LICENSE.md"):
            candidate = node.parent.parent / license_name
            if candidate.is_file():
                shutil.copy2(candidate, resources / "runtime/Node-LICENSE.txt")
                break
        sign_bundle(bundle)
        native_info = {"schemaVersion": 2, "sources": sources,
                       "unsignedBinarySHA256": native_code_fingerprint(contents / "MacOS/StudyStudioApp")}
        (resources / "NativeBuild.json").write_text(json.dumps(native_info, indent=2) + "\n")
        # Seal the source/executable relationship in the app's outer signature.
        run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", bundle)
        run("/usr/bin/codesign", "--verify", "--deep", "--strict", bundle)
        info["nativeReused"] = reused
        if final.exists():
            old = output / ".Study Studio.previous"
            if old.exists():
                shutil.rmtree(old)
            final.rename(old)
            try:
                bundle.rename(final)
            except BaseException:
                old.rename(final)
                raise
            shutil.rmtree(old)
        else:
            bundle.rename(final)
    print(json.dumps({"app": str(final), **info}, ensure_ascii=False))


if __name__ == "__main__":
    main()
