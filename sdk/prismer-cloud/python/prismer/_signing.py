"""Built-in Ed25519 auto-signing for IM message security (v1.8.0 S7).

Derives an Ed25519 keypair from the API key via SHA-256 and signs outgoing
messages with the lite protocol: ``secVersion|senderDid|type|timestamp|contentHash``.

Dependency resolution (first available wins):
  1. PyNaCl (``nacl``) -- same backend as ``aip-sdk``
  2. ``cryptography`` -- widely installed, ships with most Python distributions

If neither is available, ``MessageSigner.create()`` returns ``None`` and
signing is silently skipped.
"""

from __future__ import annotations

import base64
import hashlib
import time
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# DID:key encoding (inlined from aip.did to avoid external dependency)
# ---------------------------------------------------------------------------

_ED25519_MULTICODEC = b"\xed\x01"
_B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    result: list[bytes] = []
    while n > 0:
        n, r = divmod(n, 58)
        result.append(_B58_ALPHABET[r : r + 1])
    for byte in data:
        if byte == 0:
            result.append(b"1")
        else:
            break
    return b"".join(reversed(result)).decode("ascii")


def _public_key_to_did_key(pub_bytes: bytes) -> str:
    assert len(pub_bytes) == 32, f"Ed25519 public key must be 32 bytes, got {len(pub_bytes)}"
    return "did:key:z" + _b58encode(_ED25519_MULTICODEC + pub_bytes)


# ---------------------------------------------------------------------------
# Signing backend abstraction
# ---------------------------------------------------------------------------


class _SigningBackend:
    """Abstract interface for Ed25519 signing."""

    def sign(self, data: bytes) -> bytes:
        raise NotImplementedError

    def public_key_bytes(self) -> bytes:
        raise NotImplementedError


class _NaClBackend(_SigningBackend):
    """PyNaCl-based Ed25519 signing."""

    def __init__(self, seed: bytes):
        from nacl.signing import SigningKey  # type: ignore[import-untyped]
        from nacl.encoding import RawEncoder  # type: ignore[import-untyped]

        self._sk = SigningKey(seed)
        self._raw_encoder = RawEncoder

    def sign(self, data: bytes) -> bytes:
        signed = self._sk.sign(data, encoder=self._raw_encoder)
        return signed.signature  # 64 bytes

    def public_key_bytes(self) -> bytes:
        return bytes(self._sk.verify_key)


class _CryptographyBackend(_SigningBackend):
    """``cryptography``-based Ed25519 signing."""

    def __init__(self, seed: bytes):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        self._sk = Ed25519PrivateKey.from_private_bytes(seed)

    def sign(self, data: bytes) -> bytes:
        return self._sk.sign(data)  # 64 bytes

    def public_key_bytes(self) -> bytes:
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        raw = self._sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return raw


def _create_backend(seed: bytes) -> Optional[_SigningBackend]:
    """Try to create a signing backend with the available crypto library."""
    try:
        return _NaClBackend(seed)
    except ImportError:
        pass
    try:
        return _CryptographyBackend(seed)
    except ImportError:
        pass
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class MessageSigner:
    """Ed25519 message signer derived from an API key or raw seed bytes.

    Usage::

        signer = MessageSigner.from_api_key("sk-prismer-...")
        if signer:
            signed_body = signer.sign_body({"content": "hello", "type": "text"})
    """

    def __init__(self, backend: _SigningBackend, did: str):
        self._backend = backend
        self.did = did

    # -- Factory methods ---------------------------------------------------

    @classmethod
    def from_api_key(cls, api_key: str) -> Optional["MessageSigner"]:
        """Derive an Ed25519 keypair from the API key via SHA-256.

        Returns ``None`` if no crypto library is available.
        """
        seed = hashlib.sha256(api_key.encode()).digest()
        return cls._from_seed(seed)

    @classmethod
    def from_private_key(cls, key_bytes: bytes) -> Optional["MessageSigner"]:
        """Create a signer from raw 32-byte Ed25519 private key.

        Returns ``None`` if no crypto library is available.
        """
        if len(key_bytes) != 32:
            raise ValueError(f"Ed25519 private key must be 32 bytes, got {len(key_bytes)}")
        return cls._from_seed(key_bytes)

    @classmethod
    def _from_seed(cls, seed: bytes) -> Optional["MessageSigner"]:
        backend = _create_backend(seed)
        if backend is None:
            return None
        pub = backend.public_key_bytes()
        did = _public_key_to_did_key(pub)
        return cls(backend, did)

    # -- Signing -----------------------------------------------------------

    def sign_payload(self, content: str, msg_type: str = "text") -> Dict[str, Any]:
        """Produce the signing fields to merge into the message body.

        Returns a dict with keys: ``secVersion``, ``senderDid``, ``contentHash``,
        ``signature``, ``signedAt``.
        """
        content_hash = hashlib.sha256(content.encode()).hexdigest()
        timestamp = int(time.time() * 1000)
        payload_str = f"1|{self.did}|{msg_type}|{timestamp}|{content_hash}"
        sig_bytes = self._backend.sign(payload_str.encode())
        signature = base64.b64encode(sig_bytes).decode()
        return {
            "secVersion": 1,
            "senderDid": self.did,
            "contentHash": content_hash,
            "signature": signature,
            "signedAt": timestamp,
        }

    def sign_body(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """Return a new body dict with signing fields merged in.

        If the body already contains ``"signature"``, it is returned unchanged.
        """
        if "signature" in body:
            return body
        content = body.get("content", "")
        msg_type = body.get("type", "text")
        fields = self.sign_payload(content, msg_type)
        return {**body, **fields}
