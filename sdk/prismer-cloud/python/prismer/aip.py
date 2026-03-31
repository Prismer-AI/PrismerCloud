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
from aip_sdk import (  # type: ignore[import-untyped]
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
    "public_key_to_did_key", "did_key_to_public_key", "validate_did_key",
    "build_credential", "verify_credential", "build_presentation", "verify_presentation",
    "build_delegation", "build_ephemeral_delegation", "verify_delegation", "verify_ephemeral_delegation",
]

# TODO v1.7.4: PrismerAIPAgent with platform registration
