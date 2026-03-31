/**
 * DID:KEY encoding/decoding (Multicodec + Base58btc)
 */

const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let output = '';
  for (const byte of bytes) {
    if (byte === 0) output += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += B58_ALPHABET[digits[i]];
  }
  return output;
}

export function base58Decode(str: string): Uint8Array {
  const bytes = [0];
  for (const char of str) {
    const index = B58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char === '1') bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

export function publicKeyToDIDKey(pubBytes: Uint8Array): string {
  if (pubBytes.length !== 32) throw new Error(`Expected 32 bytes, got ${pubBytes.length}`);
  const mc = new Uint8Array(34);
  mc.set(ED25519_MULTICODEC, 0);
  mc.set(pubBytes, 2);
  return `did:key:z${base58Encode(mc)}`;
}

export function didKeyToPublicKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('Invalid did:key format');
  const decoded = base58Decode(did.slice(9));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error('Invalid did:key: wrong prefix or length');
  }
  return decoded.slice(2);
}

export function validateDIDKey(did: string): boolean {
  try {
    didKeyToPublicKey(did);
    return true;
  } catch {
    return false;
  }
}
