"""
Prismer Python SDK — File Upload Integration Tests

Runs against the local IM server (http://localhost:3200).
Start the server first: npm run im:start

Usage:
    cd sdk/python
    python -m pytest tests/test_file_upload.py -v

The standalone IM server serves routes at /api/*, but the SDK uses /api/im/*.
We work around this by setting base_url and using httpx event hooks to rewrite paths.
"""

import os
import time
import pytest
import httpx

# ---------------------------------------------------------------------------
# Path-rewriting transport for standalone IM server
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("IM_BASE_URL", "http://localhost:3200")


class _StandaloneRewriteTransport(httpx.BaseTransport):
    """Rewrites /api/im/* → /api/* for the standalone IM server."""

    def __init__(self):
        self._transport = httpx.HTTPTransport()

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        url = url.replace("/api/im/", "/api/")
        request = httpx.Request(
            method=request.method,
            url=url,
            headers=request.headers,
            content=request.content,
        )
        return self._transport.handle_request(request)

    def close(self):
        self._transport.close()


def _local_client(token=None):
    """Create a PrismerClient that rewrites /api/im/* for standalone IM server."""
    # We can't easily inject a transport into PrismerClient, so instead we
    # monkey-patch the httpx.Client after construction.
    from prismer import PrismerClient
    client = PrismerClient(api_key=token, base_url=BASE_URL, timeout=15.0)
    # Replace the transport on the internal httpx client
    client._client._transport = _StandaloneRewriteTransport()
    return client


# ---------------------------------------------------------------------------
# Module-level httpx rewrite for raw upload calls (httpx.post)
# ---------------------------------------------------------------------------

_original_httpx_post = httpx.post
_original_httpx_put = httpx.put


def _rewrite_post(url, **kwargs):
    url = url.replace("/api/im/", "/api/")
    return _original_httpx_post(url, **kwargs)


def _rewrite_put(url, **kwargs):
    url = url.replace("/api/im/", "/api/")
    return _original_httpx_put(url, **kwargs)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

RUN_ID = hex(int(time.time()))[2:]


@pytest.fixture(scope="module", autouse=True)
def patch_httpx():
    """Patch httpx.post/put to rewrite paths for standalone IM server."""
    httpx.post = _rewrite_post
    httpx.put = _rewrite_put
    yield
    httpx.post = _original_httpx_post
    httpx.put = _original_httpx_put


@pytest.fixture(scope="module")
def agent_a():
    client = _local_client()
    res = client.im.account.register(
        type="agent",
        username=f"pyfile-a-{RUN_ID}",
        displayName=f"PyFile A {RUN_ID}",
    )
    assert res.get("ok"), f"Register failed: {res}"
    token = res["data"]["token"]
    user_id = res["data"]["imUserId"]
    c = _local_client(token)
    yield {"client": c, "token": token, "user_id": user_id}
    c.close()
    client.close()


@pytest.fixture(scope="module")
def agent_b():
    client = _local_client()
    res = client.im.account.register(
        type="agent",
        username=f"pyfile-b-{RUN_ID}",
        displayName=f"PyFile B {RUN_ID}",
    )
    assert res.get("ok"), f"Register failed: {res}"
    token = res["data"]["token"]
    user_id = res["data"]["imUserId"]
    c = _local_client(token)
    yield {"client": c, "token": token, "user_id": user_id}
    c.close()
    client.close()


@pytest.fixture(scope="module")
def conversation_id(agent_a, agent_b):
    res = agent_a["client"].im.direct.send(agent_b["user_id"], "hello for file test")
    assert res.get("ok"), f"Direct send failed: {res}"
    return res["data"]["conversationId"]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFileUpload:
    """File upload integration tests (SDK high-level methods)."""

    uploaded_id: str = ""

    def test_upload_with_bytes(self, agent_a):
        """upload() with bytes — simple upload happy path."""
        data = b"Hello from Python SDK upload test"
        result = agent_a["client"].im.files.upload(
            data, file_name="test-upload.txt", mime_type="text/plain",
        )
        assert result["uploadId"]
        assert result["cdnUrl"]
        assert result["fileName"] == "test-upload.txt"
        assert result["fileSize"] == len(data)
        assert result["mimeType"] == "text/plain"
        assert isinstance(result["cost"], (int, float))
        TestFileUpload.uploaded_id = result["uploadId"]

    def test_upload_auto_mime_type(self, agent_a):
        """upload() auto-detects mimeType from file_name extension."""
        data = b"# Markdown\n\nHello!"
        result = agent_a["client"].im.files.upload(data, file_name="readme.md")
        assert result["mimeType"] == "text/markdown"
        assert result["fileName"] == "readme.md"

    def test_upload_with_file_path(self, agent_a, tmp_path):
        """upload() with file path (str input)."""
        p = tmp_path / "test-file.txt"
        p.write_text("File path upload test content")
        result = agent_a["client"].im.files.upload(str(p))
        assert result["uploadId"]
        assert result["fileName"] == "test-file.txt"

    def test_send_file(self, agent_a, conversation_id):
        """send_file() — upload + file message in one call."""
        data = b'{"key": "value"}'
        result = agent_a["client"].im.files.send_file(
            conversation_id, data,
            file_name="data.json",
            content="Here is the data file",
        )
        assert result["upload"]["uploadId"]
        assert result["upload"]["cdnUrl"]
        assert result["upload"]["mimeType"] == "application/json"
        assert result["message"] is not None

    def test_quota(self, agent_a):
        """quota() reflects uploaded files."""
        res = agent_a["client"].im.files.quota()
        assert res.get("ok")
        assert res["data"]["used"] > 0
        assert res["data"]["fileCount"] > 0
        assert isinstance(res["data"]["limit"], (int, float))
        assert isinstance(res["data"]["tier"], str)

    def test_upload_error_missing_filename(self, agent_a):
        """upload() error — missing file_name for bytes."""
        with pytest.raises(ValueError, match="file_name is required"):
            agent_a["client"].im.files.upload(b"no name")

    def test_upload_error_too_large(self, agent_a):
        """upload() error — file exceeds 50 MB (client-side)."""
        # Create a bytes-like object that pretends to be > 50 MB
        class FakeBytes(bytes):
            def __len__(self):
                return 51 * 1024 * 1024

        with pytest.raises(ValueError, match="50 MB"):
            agent_a["client"].im.files.upload(FakeBytes(b"x"), file_name="huge.bin")

    def test_types(self, agent_a):
        """types() returns allowed MIME types."""
        res = agent_a["client"].im.files.types()
        assert res.get("ok")
        assert isinstance(res["data"]["allowedMimeTypes"], list)
        assert len(res["data"]["allowedMimeTypes"]) > 0

    def test_delete(self, agent_a):
        """delete() — cleanup uploaded file."""
        assert TestFileUpload.uploaded_id
        res = agent_a["client"].im.files.delete(TestFileUpload.uploaded_id)
        assert res.get("ok")
