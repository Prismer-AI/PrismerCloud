use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Verify HMAC-SHA256 webhook signature.
pub fn verify_signature(payload: &[u8], signature: &str, secret: &str) -> bool {
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    mac.update(payload);
    let expected = hex::encode(mac.finalize().into_bytes());
    expected == signature
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute_sig(payload: &[u8], secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(payload);
        hex::encode(mac.finalize().into_bytes())
    }

    #[test]
    fn verify_correct_signature() {
        let sig = compute_sig(b"hello world", "test-secret");
        assert!(verify_signature(b"hello world", &sig, "test-secret"));
    }

    #[test]
    fn verify_wrong_signature() {
        assert!(!verify_signature(b"hello world", "wrong", "test-secret"));
    }

    #[test]
    fn verify_empty_signature() {
        assert!(!verify_signature(b"hello world", "", "test-secret"));
    }

    #[test]
    fn verify_different_payload() {
        let sig = compute_sig(b"hello world", "test-secret");
        assert!(!verify_signature(b"goodbye world", &sig, "test-secret"));
    }

    #[test]
    fn verify_different_secret() {
        let sig = compute_sig(b"hello world", "secret-a");
        assert!(!verify_signature(b"hello world", &sig, "secret-b"));
    }

    #[test]
    fn verify_empty_payload() {
        let sig = compute_sig(b"", "my-secret");
        assert!(verify_signature(b"", &sig, "my-secret"));
    }

    #[test]
    fn verify_json_payload() {
        let payload = br#"{"event":"message.new","data":{"id":"123"}}"#;
        let sig = compute_sig(payload, "webhook-secret");
        assert!(verify_signature(payload, &sig, "webhook-secret"));
    }

    #[test]
    fn verify_signature_is_hex_lowercase() {
        let sig = compute_sig(b"test", "s");
        // HMAC-SHA256 output is always 64 hex chars
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
        // verify the computed sig matches
        assert!(verify_signature(b"test", &sig, "s"));
    }
}
