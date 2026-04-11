"""Prismer SDK — AIP Identity (Platform Integration)

Re-exports aip-sdk core. Install both packages:
    pip install prismer aip-sdk

Usage (standalone):
    from prismer.aip import AIPIdentity
    identity = AIPIdentity.create()

Usage (platform integration — planned v1.7.4):
    from prismer.aip import PrismerAIPAgent
    agent = PrismerAIPAgent.register(client, api_key)
"""

# Re-export from standalone AIP SDK
from aip import (  # type: ignore[import-untyped]
    AIPIdentity,
    public_key_to_did_key,
    did_key_to_public_key,
    validate_did_key,
    build_credential,
    verify_credential,
    build_presentation,
    verify_presentation,
    build_delegation,
    build_ephemeral_delegation,
    verify_delegation,
    verify_ephemeral_delegation,
)

__all__ = [
    "AIPIdentity",
    "PrismerAIPAgent",
    "public_key_to_did_key", "did_key_to_public_key", "validate_did_key",
    "build_credential", "verify_credential", "build_presentation", "verify_presentation",
    "build_delegation", "build_ephemeral_delegation", "verify_delegation", "verify_ephemeral_delegation",
]


class PrismerAIPAgent:
    """Wraps AIPIdentity with Prismer IM platform registration (v1.8.0 S7).

    Example::

        from prismer import PrismerClient
        from prismer.aip import PrismerAIPAgent

        client = PrismerClient(api_key="sk-prismer-...")
        agent = PrismerAIPAgent.register(client, "sk-prismer-...")
        # agent.did → 'did:key:z6Mk...'
    """

    def __init__(self, identity: "AIPIdentity"):
        self.identity = identity
        self._registered = False

    @classmethod
    def register(cls, client, api_key: str) -> "PrismerAIPAgent":
        """Create agent from API key and register with Prismer IM."""
        identity = AIPIdentity.from_api_key(api_key)
        agent = cls(identity)
        agent.ensure_registered(client)
        return agent

    @classmethod
    def from_private_key(cls, client, private_key_b64: str) -> "PrismerAIPAgent":
        """Create agent from Base64 private key and register."""
        import base64
        key_bytes = base64.b64decode(private_key_b64)
        identity = AIPIdentity.from_private_key(key_bytes)
        agent = cls(identity)
        agent.ensure_registered(client)
        return agent

    def ensure_registered(self, client) -> None:
        """Register identity key with IM server (idempotent)."""
        if self._registered:
            return
        try:
            client.im.identity.register_key(self.identity.public_key_base64)
            self._registered = True
        except Exception as e:
            if "already" in str(e).lower() or getattr(e, "status_code", 0) == 409:
                self._registered = True
            else:
                raise

    @property
    def did(self) -> str:
        return self.identity.did

    @property
    def public_key_base64(self) -> str:
        return self.identity.public_key_base64
