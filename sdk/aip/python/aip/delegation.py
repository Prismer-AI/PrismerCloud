"""Verifiable and Ephemeral Delegations."""
import json, os
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional
from .identity import AIPIdentity

def build_delegation(issuer: AIPIdentity, subject_did: str, scope: List[str], role: Optional[str] = None, valid_days: Optional[int] = None) -> Dict:
    now = datetime.now(timezone.utc)
    body = {"@context": ["https://www.w3.org/ns/credentials/v2"], "type": ["VerifiableCredential", "AgentDelegation"], "issuer": issuer.did, "validFrom": now.isoformat()}
    if valid_days: body["validUntil"] = (now + timedelta(days=valid_days)).isoformat()
    subj = {"id": subject_did, "aip:scope": scope}
    if role: subj["aip:role"] = role
    body["credentialSubject"] = subj
    proof_value = issuer.sign(json.dumps(body).encode())
    return {**body, "proof": {"type": "Ed25519Signature2020", "verificationMethod": f"{issuer.did}#keys-1", "proofPurpose": "assertionMethod", "created": now.isoformat(), "proofValue": proof_value}}

def build_ephemeral_delegation(parent: AIPIdentity, scope: List[str], ttl_seconds: int) -> Dict:
    now = datetime.now(timezone.utc)
    nonce = os.urandom(16).hex()
    body = {"type": "EphemeralDelegation", "parentDid": parent.did, "sessionId": f"sub_{nonce[:8]}", "scope": scope, "validFrom": now.isoformat(), "validUntil": (now + timedelta(seconds=ttl_seconds)).isoformat(), "nonce": nonce}
    proof_value = parent.sign(json.dumps(body).encode())
    return {**body, "proof": {"type": "Ed25519Signature2020", "verificationMethod": f"{parent.did}#keys-1", "proofValue": proof_value}}

def verify_delegation(delegation: Dict) -> bool:
    if datetime.fromisoformat(delegation["validFrom"]) > datetime.now(timezone.utc): return False
    vu = delegation.get("validUntil")
    if vu and datetime.fromisoformat(vu) < datetime.now(timezone.utc): return False
    body = {k: v for k, v in delegation.items() if k != "proof"}
    return AIPIdentity.verify(json.dumps(body).encode(), delegation["proof"]["proofValue"], delegation["issuer"])

def verify_ephemeral_delegation(token: Dict) -> bool:
    if datetime.fromisoformat(token["validUntil"]) < datetime.now(timezone.utc): return False
    body = {k: v for k, v in token.items() if k != "proof"}
    return AIPIdentity.verify(json.dumps(body).encode(), token["proof"]["proofValue"], token["parentDid"])
