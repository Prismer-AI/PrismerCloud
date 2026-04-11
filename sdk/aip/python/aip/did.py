"""DID:KEY encoding/decoding (Ed25519 Multicodec + Base58btc)."""

ED25519_MULTICODEC = b"\xed\x01"
B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def _b58encode(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    result = []
    while n > 0:
        n, r = divmod(n, 58)
        result.append(B58_ALPHABET[r:r+1])
    for byte in data:
        if byte == 0: result.append(b"1")
        else: break
    return b"".join(reversed(result)).decode("ascii")

def _b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58_ALPHABET.index(c.encode())
    # Count only leading '1' characters (not all)
    pad = 0
    for c in s:
        if c == "1": pad += 1
        else: break
    result = n.to_bytes((n.bit_length() + 7) // 8, "big") if n > 0 else b""
    return b"\x00" * pad + result

def public_key_to_did_key(pub_bytes: bytes) -> str:
    assert len(pub_bytes) == 32
    return "did:key:z" + _b58encode(ED25519_MULTICODEC + pub_bytes)

def did_key_to_public_key(did: str) -> bytes:
    if not did.startswith("did:key:z"): raise ValueError(f"Invalid did:key: {did[:20]}")
    decoded = _b58decode(did[9:])
    if len(decoded) != 34 or decoded[:2] != ED25519_MULTICODEC:
        raise ValueError("Invalid did:key: wrong prefix or length")
    return decoded[2:]

def validate_did_key(did: str) -> bool:
    try: did_key_to_public_key(did); return True
    except: return False
