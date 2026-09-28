#!/usr/bin/env python3
"""Install missing gh; verify version and authentication independently."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import stat
import zipfile
import urllib.request


def run_command(argv):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(argv, 1, '', 'unavailable or timed out')


def download(url, limit):
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('download exceeds limit')
    return data


def install_binary(system, fetch=download):
    """Official release plus SHA256; extract only one regular executable."""
    arch = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    if system not in ('Linux', 'Darwin') or not arch:
        raise ValueError('unsupported host architecture')
    release = json.loads(fetch('https://api.github.com/repos/cli/cli/releases/latest', 2_000_000))
    tag = release.get('tag_name', '') if isinstance(release, dict) else ''
    if not re.fullmatch(r'v2\.\d+\.\d+', tag):
        raise ValueError('unrecognized stable release')
    version = tag[1:]
    stem = f"gh_{version}_{'linux' if system == 'Linux' else 'macOS'}_{arch}"
    name = stem + ('.tar.gz' if system == 'Linux' else '.zip')
    base = f'https://github.com/cli/cli/releases/download/{tag}/'
    sums = fetch(base + f'gh_{version}_checksums.txt', 200_000).decode('ascii')
    expected = [line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1] == name]
    if len(expected) != 1 or not re.fullmatch('[0-9a-fA-F]{64}', expected[0]):
        raise ValueError('missing release checksum')
    archive = fetch(base + name, 50_000_000)
    if hashlib.sha256(archive).hexdigest() != expected[0].lower():
        raise ValueError('checksum mismatch')
    if system == 'Darwin':
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            members = [m for m in zipped.infolist() if m.filename == stem + '/bin/gh']
            if (len(members) != 1 or members[0].is_dir() or
                    stat.S_ISLNK(members[0].external_attr >> 16) or members[0].file_size > 100_000_000):
                raise ValueError('unexpected executable entry')
            data = zipped.read(members[0])
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
            members = [m for m in tar.getmembers() if m.name == stem + '/bin/gh']
            if len(members) != 1 or not members[0].isfile() or members[0].size > 100_000_000:
                raise ValueError('unexpected executable entry')
            data = tar.extractfile(members[0]).read(100_000_001)
    target = Path.home() / '.local' / 'bin' / 'gh'
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as handle:
        handle.write(data)
    target.chmod(0o755)
    return str(target)


def ensure(run=run_command, binary_installer=install_binary, check_only=False, host='github.com'):
    if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', host):
        return {'state': 'invalid-host', 'installed': False, 'authenticated': False}
    executable = find_gh()
    result = {'state': 'missing', 'installed': False, 'authenticated': False, 'host': host}
    if not executable:
        if check_only:
            return result
        system = platform.system()
        brew = shutil.which('brew') if system in ('Darwin', 'Linux') else None
        winget = shutil.which('winget') if system == 'Windows' else None
        command = ([brew, 'install', 'gh'] if brew else
                   [winget, 'install', '--id', 'GitHub.cli', '--exact', '--source', 'winget', '--silent', '--disable-interactivity'] if winget else None)
        try:
            if command:
                if run(command).returncode:
                    return {**result, 'state': 'install-failed'}
                executable = find_gh() or 'gh'
            else:
                executable = binary_installer(system)
        except (OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile):
            return {**result, 'state': 'install-failed'}
    version = run([executable, '--version'])
    match = re.search(r'^gh version (\d+)\.(\d+)\.(\d+)\b', version.stdout, re.MULTILINE)
    if version.returncode or not match or int(match[1]) < 2:
        return {**result, 'state': 'version-check-failed', 'executable': executable}
    result.update(installed=True, executable=executable, version=match[0])
    auth = run([executable, 'auth', 'status', '--hostname', host])
    result.update(authenticated=auth.returncode == 0,
                  state='ready-for-repository-check' if auth.returncode == 0 else 'authentication-required')
    return result


def find_gh():
    found = shutil.which('gh')
    if found:
        return found
    candidates = [Path.home() / '.local/bin/gh']
    if platform.system() == 'Windows':
        if os.environ.get('ProgramFiles'):
            candidates.append(Path(os.environ['ProgramFiles']) / 'GitHub CLI/gh.exe')
        if os.environ.get('LOCALAPPDATA'):
            candidates.append(Path(os.environ['LOCALAPPDATA']) / 'Microsoft/WinGet/Links/gh.exe')
    return next((str(p) for p in candidates if p.is_file()), None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('--host', default='github.com')
    args = parser.parse_args()
    result = ensure(check_only=args.check_only, host=args.host)
    print(json.dumps(result))
    return 0 if result['authenticated'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
