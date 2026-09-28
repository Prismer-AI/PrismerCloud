"""Compatibility names; credentials belong to an explicit Prismer account profile."""
import os
from pathlib import Path


def get_hermes_home():
    value = os.environ.get('PRISMER_GOOGLE_PROFILE')
    if not value:
        return Path.cwd() / '.prismer-google-unconfigured'
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError('PRISMER_GOOGLE_PROFILE must be absolute')
    return path


def display_hermes_home():
    return str(get_hermes_home())
