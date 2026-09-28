#!/usr/bin/env python3
"""Guarded Markdown writes for a user-selected, non-hostile local vault.

POSIX only: cooperative flock, no-follow directory handles and revision checks.
External editors do not honor flock; synchronize/pause them before replacement.
"""
import argparse
import hashlib
import os
from pathlib import Path
import secrets
import stat
import sys


def write_note(vault, relative, content, expected):
    import fcntl
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in ('.', '..') for p in path.parts):
        raise ValueError('Expected a relative path inside the vault')
    if path.suffix.lower() != '.md' or len(content) > 8 * 1024 * 1024:
        raise ValueError('Only bounded Markdown notes are accepted')
    root = Path(vault).expanduser().resolve(strict=True)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    temporary = None
    try:
        for part in path.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        lock = os.open('.prismer-note-write.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        fcntl.flock(lock, fcntl.LOCK_EX)

        def revision():
            try:
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            except FileNotFoundError:
                return 'missing', 0o600
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
                    raise ValueError('Not a bounded regular note')
                return hashlib.sha256(source.read()).hexdigest(), stat.S_IMODE(info.st_mode)

        current, mode = revision()
        if current != expected:
            raise ValueError('Concurrent modification: read the note again')
        temporary = '.prismer-note-' + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        if revision()[0] != expected:
            raise ValueError('Concurrent modification before replacement')
        if expected == 'missing':
            # link is atomic and refuses an existing destination.
            os.link(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(temporary, dir_fd=directory)
        else:
            os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        temporary = None
        os.fsync(directory)
        return hashlib.sha256(content).hexdigest()
    finally:
        if temporary is not None:
            os.unlink(temporary, dir_fd=directory)
        if lock is not None:
            os.close(lock)
        os.close(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', required=True)
    parser.add_argument('--path', required=True)
    parser.add_argument('--expected-sha256', required=True, help='SHA256 from the read, or missing for creation')
    args = parser.parse_args()
    try:
        print(write_note(args.vault, args.path, sys.stdin.buffer.read(8 * 1024 * 1024 + 1), args.expected_sha256))
    except (OSError, ValueError, ImportError) as error:
        print('Note not written: ' + str(error), file=sys.stderr)
        sys.exit(1)
