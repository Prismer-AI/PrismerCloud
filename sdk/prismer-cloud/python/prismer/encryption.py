"""E2E Encryption — AES-256-GCM with ECDH P-256 key exchange.

Interoperable with TypeScript, Go, and Rust SDKs:
- Master key: PBKDF2-SHA256 (100k iterations), random 16-byte salt (per-user)
- Session keys: AES-256-GCM per conversation
- Ciphertext format: base64(12-byte-IV + ciphertext)
"""

import base64
import hashlib
import os
from typing import Dict, Optional, Tuple

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes, serialization


PBKDF2_ITERATIONS = 100_000
KEY_LENGTH = 32  # AES-256
IV_LENGTH = 12   # GCM nonce
SALT_LENGTH = 16


class E2EEncryption:
    """E2E encryption manager — AES-256-GCM + ECDH P-256."""

    def __init__(self) -> None:
        self._master_key: Optional[bytes] = None
        self._salt: Optional[bytes] = None
        self._session_keys: Dict[str, bytes] = {}
        self._private_key: Optional[ec.EllipticCurvePrivateKey] = None
        self._public_key_bytes: Optional[bytes] = None

    def init(self, passphrase: str, salt: Optional[str] = None) -> None:
        """Initialize with passphrase — derives master key via PBKDF2.

        Args:
            passphrase: User passphrase for master key derivation.
            salt: Optional Base64-encoded salt. If omitted, a random 16-byte salt
                  is generated. Store via export_salt() to re-derive the same key.
        """
        self._salt = base64.b64decode(salt) if salt else os.urandom(SALT_LENGTH)
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=KEY_LENGTH,
            salt=self._salt,
            iterations=PBKDF2_ITERATIONS,
        )
        self._master_key = kdf.derive(passphrase.encode("utf-8"))

        # Generate ECDH P-256 keypair
        self._private_key = ec.generate_private_key(ec.SECP256R1())
        self._public_key_bytes = self._private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )

    @property
    def is_initialized(self) -> bool:
        return self._master_key is not None

    def export_salt(self) -> str:
        """Export the salt as Base64 for persistent storage."""
        if self._salt is None:
            raise RuntimeError("Call init() first")
        return base64.b64encode(self._salt).decode("ascii")

    def export_public_key(self) -> Optional[str]:
        """Export public key as base64 for sharing with peers."""
        if self._public_key_bytes is None:
            return None
        return base64.b64encode(self._public_key_bytes).decode("ascii")

    def derive_session_key(self, conversation_id: str, peer_public_key_b64: str) -> bytes:
        """Derive a shared session key via ECDH from a peer's public key."""
        if self._private_key is None:
            raise RuntimeError("Call init() first")
        peer_bytes = base64.b64decode(peer_public_key_b64)
        peer_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), peer_bytes)
        shared_key = self._private_key.exchange(ec.ECDH(), peer_key)
        # Use first 32 bytes of SHA-256(shared_secret) as session key
        session_key = hashlib.sha256(shared_key).digest()
        self._session_keys[conversation_id] = session_key
        return session_key

    def set_session_key(self, conversation_id: str, key: bytes) -> None:
        """Set a pre-shared session key for a conversation."""
        if len(key) != KEY_LENGTH:
            raise ValueError(f"Session key must be {KEY_LENGTH} bytes")
        self._session_keys[conversation_id] = key

    def generate_session_key(self, conversation_id: str) -> bytes:
        """Generate a random session key for a conversation."""
        key = os.urandom(KEY_LENGTH)
        self._session_keys[conversation_id] = key
        return key

    def has_session_key(self, conversation_id: str) -> bool:
        return conversation_id in self._session_keys

    def encrypt(self, conversation_id: str, plaintext: str) -> str:
        """Encrypt plaintext. Returns base64(IV + ciphertext)."""
        key = self._session_keys.get(conversation_id)
        if key is None:
            raise KeyError(f"No session key for conversation: {conversation_id}")
        iv = os.urandom(IV_LENGTH)
        aesgcm = AESGCM(key)
        ciphertext = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
        return base64.b64encode(iv + ciphertext).decode("ascii")

    def decrypt(self, conversation_id: str, encrypted: str) -> str:
        """Decrypt base64(IV + ciphertext)."""
        key = self._session_keys.get(conversation_id)
        if key is None:
            raise KeyError(f"No session key for conversation: {conversation_id}")
        combined = base64.b64decode(encrypted)
        if len(combined) < IV_LENGTH + 1:
            raise ValueError("Ciphertext too short")
        iv = combined[:IV_LENGTH]
        ciphertext = combined[IV_LENGTH:]
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(iv, ciphertext, None)
        return plaintext.decode("utf-8")
