"""Verifiable Credentials and Presentations."""

import json
from datetime import datetime, timezone
from typing import Dict, Any, List
from .identity import AIPIdentity


def _protocol_json(value: Dict) -> str:
    """Match the compact JSON text used by the TypeScript implementation."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def build_credential(
    issuer: AIPIdentity, holder_did: str, cred_type: str, claims: Dict[str, Any]
) -> Dict:
    now = datetime.now(timezone.utc).isoformat()
    body = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "type": ["VerifiableCredential", cred_type],
        "issuer": issuer.did,
        "validFrom": now,
        "credentialSubject": {"id": holder_did, **claims},
    }
    proof_value = issuer.sign(_protocol_json(body).encode())
    return {
        **body,
        "proof": {
            "type": "Ed25519Signature2020",
            "verificationMethod": f"{issuer.did}#keys-1",
            "proofPurpose": "assertionMethod",
            "created": now,
            "proofValue": proof_value,
        },
    }


def verify_credential(vc: Dict) -> bool:
    proof = vc.get("proof", {})
    body = {k: v for k, v in vc.items() if k != "proof"}
    return AIPIdentity.verify(
        _protocol_json(body).encode(), proof.get("proofValue", ""), vc.get("issuer", "")
    )


def build_presentation(
    holder: AIPIdentity, credentials: List[Dict], challenge: str
) -> Dict:
    body = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "type": ["VerifiablePresentation"],
        "holder": holder.did,
        "verifiableCredential": credentials,
    }
    data = (_protocol_json(body) + challenge).encode()
    proof_value = holder.sign(data)
    return {
        **body,
        "proof": {
            "type": "Ed25519Signature2020",
            "verificationMethod": f"{holder.did}#keys-1",
            "challenge": challenge,
            "proofValue": proof_value,
        },
    }


def verify_presentation(vp: Dict, expected_challenge: str) -> bool:
    if vp.get("proof", {}).get("challenge") != expected_challenge:
        return False
    body = {k: v for k, v in vp.items() if k != "proof"}
    data = (_protocol_json(body) + expected_challenge).encode()
    if not AIPIdentity.verify(data, vp["proof"]["proofValue"], vp["holder"]):
        return False
    return all(verify_credential(vc) for vc in vp.get("verifiableCredential", []))
