from aip import (
    AIPIdentity,
    build_credential,
    build_presentation,
    verify_credential,
    verify_presentation,
)


def test_credential_and_challenge_bound_presentation() -> None:
    issuer = AIPIdentity.create()
    holder = AIPIdentity.create()
    credential = build_credential(
        issuer,
        holder.did,
        "AgentCapabilityCredential",
        {"aip:capability": "code-review"},
    )
    presentation = build_presentation(holder, [credential], "challenge-1")

    assert verify_credential(credential)
    assert verify_presentation(presentation, "challenge-1")
    assert not verify_presentation(presentation, "challenge-2")


def test_tampered_credential_fails() -> None:
    issuer = AIPIdentity.create()
    holder = AIPIdentity.create()
    credential = build_credential(issuer, holder.did, "ScoreCredential", {"score": 1})
    credential["credentialSubject"]["score"] = 2

    assert not verify_credential(credential)
