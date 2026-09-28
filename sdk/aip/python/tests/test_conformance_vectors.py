import json
import os
from pathlib import Path

from aip import (
    AIPIdentity,
    did_key_to_public_key,
    public_key_to_did_key,
    validate_did_key,
    verify_credential,
    verify_delegation,
    verify_presentation,
)


def fixtures_dir() -> Path:
    configured = os.environ.get("AIP_FIXTURES_DIR")
    return (
        Path(configured).resolve()
        if configured
        else Path(__file__).parents[2] / "fixtures"
    )


def fixture(name: str) -> dict:
    return json.loads((fixtures_dir() / name).read_text(encoding="utf-8"))


def test_did_key_vectors() -> None:
    vectors = fixture("did-key.json")
    for vector in vectors["vectors"]:
        identity = AIPIdentity.from_private_key(vector["privateKeyBase64"])
        assert identity.did == vector["did"], vector["name"]
        assert identity.public_key_base64 == vector["publicKeyBase64"], vector["name"]
        assert public_key_to_did_key(identity.public_key) == vector["did"], vector[
            "name"
        ]
        assert did_key_to_public_key(vector["did"]) == identity.public_key, vector[
            "name"
        ]
    for vector in vectors["compatibilityDerivations"]:
        assert AIPIdentity.from_api_key(vector["apiKey"]).did == vector["did"]
    for did in vectors["invalidDids"]:
        assert not validate_did_key(did), did


def test_signature_vectors() -> None:
    for vector in fixture("signatures.json")["vectors"]:
        message = vector["messageUtf8"].encode()
        assert (
            AIPIdentity.verify(message, vector["signatureBase64"], vector["signerDid"])
            is vector["expectedValid"]
        ), vector["name"]
        if vector.get("signerPrivateKeyBase64"):
            identity = AIPIdentity.from_private_key(vector["signerPrivateKeyBase64"])
            assert identity.sign(message) == vector["signatureBase64"], vector["name"]


def test_delegation_vectors() -> None:
    for vector in fixture("delegations.json")["vectors"]:
        assert verify_delegation(vector["delegation"]) is vector["expectedValid"], (
            vector["name"]
        )


def test_credential_and_presentation_vectors() -> None:
    vectors = fixture("credentials.json")
    for vector in vectors["credentialVectors"]:
        assert verify_credential(vector["credential"]) is vector["expectedValid"], (
            vector["name"]
        )
    for vector in vectors["presentationVectors"]:
        assert (
            verify_presentation(vector["presentation"], vector["expectedChallenge"])
            is vector["expectedValid"]
        ), vector["name"]
