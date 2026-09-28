import base64

from aip import AIPIdentity, validate_did_key


def test_random_identity_round_trip_and_signature() -> None:
    identity = AIPIdentity.create()
    restored = AIPIdentity.from_private_key(identity.export_private_key())
    message = b"standalone AIP identity"

    assert restored.did == identity.did
    assert validate_did_key(identity.did)
    assert AIPIdentity.verify(message, identity.sign(message), identity.did)


def test_private_key_export_is_a_32_byte_seed() -> None:
    identity = AIPIdentity.create()
    assert len(base64.b64decode(identity.export_private_key())) == 32
