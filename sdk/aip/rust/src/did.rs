//! DID:KEY encoding/decoding

const ED25519_MULTICODEC: [u8; 2] = [0xed, 0x01];
const B58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn public_key_to_did_key(pub_bytes: &[u8; 32]) -> String {
    let mut mc = Vec::with_capacity(34);
    mc.extend_from_slice(&ED25519_MULTICODEC);
    mc.extend_from_slice(pub_bytes);
    format!("did:key:z{}", b58_encode(&mc))
}

pub fn did_key_to_public_key(did: &str) -> Result<[u8; 32], String> {
    if !did.starts_with("did:key:z") { return Err("invalid did:key format".into()); }
    let decoded = b58_decode(&did[9..]);
    if decoded.len() != 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
        return Err("invalid did:key: wrong prefix or length".into());
    }
    let mut result = [0u8; 32];
    result.copy_from_slice(&decoded[2..]);
    Ok(result)
}

pub fn validate_did_key(did: &str) -> bool { did_key_to_public_key(did).is_ok() }

fn b58_encode(input: &[u8]) -> String {
    if input.is_empty() { return String::new(); }
    let zeros = input.iter().take_while(|&&b| b == 0).count();
    let size = input.len() * 138 / 100 + 1;
    let mut buf = vec![0u8; size];
    for &b in input {
        let mut carry = b as usize;
        for digit in buf.iter_mut().rev() { carry += 256 * (*digit as usize); *digit = (carry % 58) as u8; carry /= 58; }
    }
    let start = buf.iter().position(|&b| b != 0).unwrap_or(size);
    let mut result = String::with_capacity(zeros + size - start);
    for _ in 0..zeros { result.push('1'); }
    for &b in &buf[start..] { result.push(B58_ALPHABET[b as usize] as char); }
    result
}

fn b58_decode(s: &str) -> Vec<u8> {
    if s.is_empty() { return vec![]; }
    let zeros = s.chars().take_while(|&c| c == '1').count();
    let size = s.len() * 733 / 1000 + 1;
    let mut buf = vec![0u8; size];
    for c in s.chars() {
        let idx = B58_ALPHABET.iter().position(|&a| a == c as u8).unwrap_or(0);
        let mut carry = idx;
        for digit in buf.iter_mut().rev() { carry += 58 * (*digit as usize); *digit = (carry % 256) as u8; carry /= 256; }
    }
    let start = buf.iter().position(|&b| b != 0).unwrap_or(size);
    let mut result = vec![0u8; zeros];
    result.extend_from_slice(&buf[start..]);
    result
}
