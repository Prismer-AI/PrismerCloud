"""Shared fixtures for Prismer SDK integration tests."""

import os
import uuid
import pytest

from prismer import PrismerClient

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

API_KEY = os.environ.get("PRISMER_API_KEY_TEST")
if not API_KEY:
    raise RuntimeError("PRISMER_API_KEY_TEST environment variable is required")
BASE_URL = os.environ.get("PRISMER_BASE_URL_TEST", "https://prismer.cloud")

# Unique run id to avoid username collisions across test runs
RUN_ID = uuid.uuid4().hex[:8]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def api_key():
    return API_KEY


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def run_id():
    return RUN_ID


@pytest.fixture(scope="session")
def client(api_key, base_url):
    """Top-level PrismerClient authenticated with the platform API key."""
    c = PrismerClient(api_key=api_key, base_url=base_url, timeout=60.0)
    yield c
    c.close()
