"""@prismer/aip-sdk — Agent Identity Protocol for AI Agents (Python)"""
from .identity import AIPIdentity
from .did import public_key_to_did_key, did_key_to_public_key, validate_did_key
from .credentials import build_credential, verify_credential, build_presentation, verify_presentation
from .delegation import build_delegation, build_ephemeral_delegation, verify_delegation, verify_ephemeral_delegation

__all__ = [
    "AIPIdentity",
    "public_key_to_did_key", "did_key_to_public_key", "validate_did_key",
    "build_credential", "verify_credential", "build_presentation", "verify_presentation",
    "build_delegation", "build_ephemeral_delegation", "verify_delegation", "verify_ephemeral_delegation",
]
