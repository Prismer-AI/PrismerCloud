package aip

import "errors"

const b58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

var ed25519MulticodecPrefix = []byte{0xed, 0x01}

func PublicKeyToDIDKey(pub []byte) (string, error) {
	if len(pub) != 32 { return "", errors.New("expected 32-byte Ed25519 public key") }
	mc := make([]byte, 34)
	copy(mc, ed25519MulticodecPrefix)
	copy(mc[2:], pub)
	return "did:key:z" + b58encode(mc), nil
}

func DIDKeyToPublicKey(did string) ([]byte, error) {
	if len(did) < 10 || did[:9] != "did:key:z" { return nil, errors.New("invalid did:key format") }
	decoded := b58decode(did[9:])
	if len(decoded) != 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
		return nil, errors.New("invalid did:key: wrong prefix or length")
	}
	return decoded[2:], nil
}

func ValidateDIDKey(did string) bool {
	_, err := DIDKeyToPublicKey(did)
	return err == nil
}

func b58encode(input []byte) string {
	if len(input) == 0 { return "" }
	zeros := 0
	for _, b := range input { if b == 0 { zeros++ } else { break } }
	size := len(input)*138/100 + 1
	buf := make([]byte, size)
	for _, b := range input {
		carry := int(b)
		for i := size - 1; i >= 0; i-- {
			carry += 256 * int(buf[i]); buf[i] = byte(carry % 58); carry /= 58
		}
	}
	start := 0
	for start < size && buf[start] == 0 { start++ }
	result := make([]byte, zeros+size-start)
	for i := 0; i < zeros; i++ { result[i] = '1' }
	for i := start; i < size; i++ { result[zeros+i-start] = b58Alphabet[buf[i]] }
	return string(result)
}

func b58decode(s string) []byte {
	if len(s) == 0 { return []byte{} }
	zeros := 0
	for _, c := range s { if c == '1' { zeros++ } else { break } }
	size := len(s)*733/1000 + 1
	buf := make([]byte, size)
	for _, c := range s {
		idx := 0
		for i, a := range b58Alphabet { if byte(c) == byte(a) { idx = i; break } }
		carry := idx
		for i := size - 1; i >= 0; i-- {
			carry += 58 * int(buf[i]); buf[i] = byte(carry % 256); carry /= 256
		}
	}
	start := 0
	for start < size && buf[start] == 0 { start++ }
	result := make([]byte, zeros)
	result = append(result, buf[start:]...)
	return result
}
