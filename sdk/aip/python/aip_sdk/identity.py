"""AIPIdentity — Ed25519 DID identity for AI Agents."""
import hashlib, base64
from typing import Optional, List, Dict, Any
from nacl.signing import SigningKey, VerifyKey
from nacl.encoding import RawEncoder
from .did import public_key_to_did_key, did_key_to_public_key

class AIPIdentity:
    def __init__(self, signing_key: SigningKey):
        self._sk = signing_key
        self._vk = signing_key.verify_key
        self.public_key = bytes(self._vk)
        self.did = public_key_to_did_key(self.public_key)

    @classmethod
    def create(cls) -> "AIPIdentity":
        return cls(SigningKey.generate())

    @classmethod
    def from_api_key(cls, api_key: str) -> "AIPIdentity":
        seed = hashlib.sha256(api_key.encode()).digest()
        return cls(SigningKey(seed))

    @classmethod
    def from_private_key(cls, priv_b64: str) -> "AIPIdentity":
        return cls(SigningKey(base64.b64decode(priv_b64)))

    @property
    def public_key_base64(self) -> str:
        return base64.b64encode(self.public_key).decode()

    def sign(self, data: bytes) -> str:
        signed = self._sk.sign(data, encoder=RawEncoder)
        return base64.b64encode(signed.signature).decode()

    @staticmethod
    def verify(data: bytes, sig_b64: str, signer_did: str) -> bool:
        try:
            vk = VerifyKey(did_key_to_public_key(signer_did))
            vk.verify(data, base64.b64decode(sig_b64))
            return True
        except: return False

    def get_did_document(self, capabilities: Optional[List[str]] = None) -> Dict[str, Any]:
        from datetime import datetime, timezone
        key_id = f"{self.did}#keys-1"
        now = datetime.now(timezone.utc).isoformat()
        doc: Dict[str, Any] = {
            "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"],
            "id": self.did, "controller": self.did,
            "verificationMethod": [{"id": key_id, "type": "Ed25519VerificationKey2020", "controller": self.did, "publicKeyMultibase": self.did[8:]}],
            "authentication": [key_id], "assertionMethod": [key_id],
            "capabilityDelegation": [key_id], "capabilityInvocation": [key_id],
            "created": now, "updated": now,
        }
        if capabilities: doc["aip:capabilities"] = capabilities
        return doc

    def export_private_key(self) -> str:
        return base64.b64encode(bytes(self._sk)).decode()
