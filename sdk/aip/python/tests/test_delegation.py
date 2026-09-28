from aip import AIPIdentity, build_delegation, verify_delegation


def test_delegation_verifies_and_tampering_fails() -> None:
    issuer = AIPIdentity.create()
    subject = AIPIdentity.create()
    delegation = build_delegation(
        issuer,
        subject.did,
        ["task:read"],
        role="worker",
        valid_days=1,
    )

    assert verify_delegation(delegation)

    tampered = {**delegation, "credentialSubject": {**delegation["credentialSubject"]}}
    tampered["credentialSubject"]["aip:scope"] = ["task:admin"]
    assert not verify_delegation(tampered)
