"""Private atomic connector files and fail-closed inter-process refresh locking."""
import contextlib
import json
import os
from pathlib import Path
import tempfile


def validate_token(payload):
    if payload.get('token_uri') != 'https://oauth2.googleapis.com/token':
        raise ValueError('Only the Google OAuth token endpoint is supported')
    return payload


def private_write(path, payload):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('refusing symlink credential file')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


@contextlib.contextmanager
def token_lock(path):
    lock = Path(str(path) + '.lock')
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.close(fd)
        yield
    finally:
        lock.unlink()
