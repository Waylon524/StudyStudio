#!/usr/bin/env python3
"""Replace the local Study Studio app; retain rollback only until readiness passes."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request

INSTALL_TARGET = Path('/Applications/Study Studio.app')
BUNDLE_ID = 'com.waylon.studystudio'
ROOT = Path(__file__).resolve().parent.parent
LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

def run(*args, capture=False):
    result = subprocess.run([str(a) for a in args], check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ''

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def inspect_bundle(bundle):
    if bundle.is_symlink() or not bundle.is_dir():
        raise RuntimeError('The app must be a real bundle, not a symbolic link.')
    for parent, dirs, files in os.walk(bundle, followlinks=False):
        if any((Path(parent) / name).is_symlink() for name in dirs + files):
            raise RuntimeError('The app bundle contains a symbolic link.')
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != BUNDLE_ID or info.get('CFBundleExecutable') != 'StudyStudioApp':
        raise RuntimeError('This is not the expected Study Studio app.')
    app = bundle / 'Contents/Resources/app'
    package = json.loads((app / 'package.json').read_text())
    version = info.get('CFBundleShortVersionString')
    if not version or package.get('version') != version:
        raise RuntimeError('Native and web app versions differ.')
    if not (bundle / 'Contents/MacOS/StudyStudioApp').is_file() or not (app / 'dist/index.html').is_file():
        raise RuntimeError('The app bundle is incomplete.')
    if (app / '.data').exists():
        raise RuntimeError('Mutable data must not be embedded in the app.')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', bundle)
    return {'version': version, 'binary': digest(bundle / 'Contents/MacOS/StudyStudioApp'),
            'frontend': digest(app / 'dist/index.html')}

class MacRuntime:
    def pids(self):
        found = subprocess.run(['/usr/bin/pgrep', '-x', 'StudyStudioApp'], capture_output=True, text=True)
        if found.returncode not in (0, 1):
            raise RuntimeError('Unable to inspect running Study Studio processes.')
        return [int(value) for value in found.stdout.split()]

    def executable(self, pid):
        result = subprocess.run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'txt', '-Fn'], capture_output=True, text=True)
        return {line[1:] for line in result.stdout.splitlines() if line.startswith('n')}

    def health(self):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4317/api/health', timeout=.5) as response:
                return json.load(response)
        except Exception:
            return None

    def listener_pids(self):
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:4317', '-sTCP:LISTEN', '-t'], capture_output=True, text=True)
        if result.returncode not in (0, 1):
            raise RuntimeError('Unable to inspect the local service listener.')
        return [int(value) for value in result.stdout.split()]

    def launch(self, app):
        run('/usr/bin/open', '-n', app)

    def ready(self, target, expected, previous_token, timeout):
        deadline = time.monotonic() + timeout
        binary = str(target / 'Contents/MacOS/StudyStudioApp')
        node = str(target / 'Contents/Resources/runtime/node')
        while time.monotonic() < deadline:
            health = self.health()
            token = health.get('instanceToken') if health else None
            if health and health.get('app') == 'study-studio' and health.get('version') == expected['version'] and token and token != previous_token:
                apps = {pid for pid in self.pids() if binary in self.executable(pid)}
                for pid in self.listener_pids():
                    parent = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'ppid='], capture_output=True, text=True)
                    if node not in self.executable(pid) or parent.stdout.strip() not in {str(p) for p in apps}:
                        continue
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:4317/', timeout=1) as response:
                            index_hash = hashlib.sha256(response.read()).hexdigest()
                        if index_hash == expected['frontend']:
                            return
                    except Exception:
                        pass
            time.sleep(.25)
        raise RuntimeError('The new app did not become ready; restoring the previous app.')

    def stop_installed(self, target):
        binary = str(target / 'Contents/MacOS/StudyStudioApp')
        pids = [pid for pid in self.pids() if binary in self.executable(pid)]
        for pid in pids:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if not any(pid in self.pids() for pid in pids):
                return
            time.sleep(.1)
        raise RuntimeError('The failed new app is still running. Rollback is retained for recovery.')

    def register(self, target):
        subprocess.run([LSREGISTER, '-f', str(target)], check=True, capture_output=True, text=True)


@contextmanager
def update_lock(parent):
    # One reusable lock file prevents simultaneous replacements; no app/data copies.
    descriptor = os.open(parent / '.study-studio-update.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Study Studio update is running.')
        yield
    finally:
        os.close(descriptor)


def install(staged, *, runtime=None, timeout=45):
    if INSTALL_TARGET.parent.is_symlink():
        raise RuntimeError('Refusing an ambiguous installation path.')
    with update_lock(INSTALL_TARGET.parent):
        return _install(staged, runtime=runtime, timeout=timeout)


def _install(staged, *, runtime=None, timeout=45):
    runtime = runtime or MacRuntime()
    target = INSTALL_TARGET
    if target.parent.is_symlink() or target.is_symlink() or staged.resolve() == target.resolve():
        raise RuntimeError('Refusing an ambiguous installation path.')
    expected = inspect_bundle(staged)
    previous = inspect_bundle(target) if target.exists() else None
    if runtime.pids() or runtime.listener_pids():
        raise RuntimeError('Please close Study Studio before updating. No app was changed.')
    previous_health = runtime.health()
    previous_token = previous_health.get('instanceToken') if previous_health else None
    # A hard interruption leaves this one bounded rollback transaction for recovery.
    leftovers = list(target.parent.glob('.study-studio-update-*'))
    if leftovers:
        raise RuntimeError('An interrupted Study Studio update remains; recover it before starting another update: ' + ', '.join(map(str, leftovers)))
    transaction = Path(tempfile.mkdtemp(prefix='.study-studio-update-', dir=target.parent))
    incoming, rollback = transaction / 'incoming.app', transaction / 'previous'
    keep_transaction = False
    successful = False
    try:
        shutil.copytree(staged, incoming)
        if inspect_bundle(incoming) != expected:
            raise RuntimeError('The copied app differs from the verified package.')
        if target.exists():
            target.rename(rollback)
        try:
            incoming.rename(target)
        except BaseException:
            if rollback.exists():
                rollback.rename(target)
            raise
        try:
            runtime.launch(target)
            runtime.ready(target, expected, previous_token, timeout)
            if inspect_bundle(target) != expected:
                raise RuntimeError('The installed app changed during verification.')
            runtime.register(target)
        except BaseException:
            try:
                runtime.stop_installed(target)
                shutil.rmtree(target)
                if rollback.exists():
                    rollback.rename(target)
                    runtime.register(target)
                    runtime.launch(target)
            except BaseException as recovery_error:
                keep_transaction = True
                raise RuntimeError('Update failed; rollback files are retained at ' + str(transaction)) from recovery_error
            raise
        successful = True
        if rollback.exists():
            shutil.rmtree(rollback)
        return {'app': str(target), 'version': expected['version'], 'replacedVersion': previous['version'] if previous else None,
                'ready': True, 'rollbackRemoved': True}
    finally:
        # A failed rename/recovery must never discard the only previous bundle.
        if rollback.exists() and not successful:
            keep_transaction = True
        if not keep_transaction and transaction.exists():
            shutil.rmtree(transaction)


def clean_owned_builds():
    # Reproducible intermediates only. Keep dist (npm start), node_modules and all data.
    for relative in ('native/.build', 'build/macos/Study Studio.app', 'script/__pycache__', 'node_modules/.vite-temp'):
        candidate = ROOT / relative
        if candidate.is_symlink():
            continue
        if candidate.is_dir():
            shutil.rmtree(candidate)
    for relative in ('build/macos', 'build'):
        try:
            (ROOT / relative).rmdir()
        except (FileNotFoundError, OSError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--clean-builds', action='store_true')
    args = parser.parse_args()
    result = install(args.bundle.expanduser().absolute())
    if args.clean_builds:
        clean_owned_builds()
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
