//! E2E Encryption — AES-256-GCM with ECDH P-256 key exchange.
//!
//! Matches the TypeScript SDK's encryption implementation:
//! - Master key: PBKDF2-SHA256 (100k iterations) from passphrase
//! - Session keys: AES-256-GCM per conversation
//! - Key exchange: ECDH P-256

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use p256::{
    ecdh::EphemeralSecret,
    PublicKey,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::collections::HashMap;

const SALT_LENGTH: usize = 16;

/// E2E encryption manager.
pub struct E2EEncryption {
    master_key: Option<[u8; 32]>,
    salt: Option<Vec<u8>>,
    session_keys: HashMap<String, [u8; 32]>,
    private_key: Option<EphemeralSecret>,
    public_key_bytes: Option<Vec<u8>>,
}

impl E2EEncryption {
    /// Create a new encryption manager.
    pub fn new() -> Self {
        Self {
            master_key: None,
            salt: None,
            session_keys: HashMap::new(),
            private_key: None,
            public_key_bytes: None,
        }
    }

    /// Initialize with a passphrase — derives master key via PBKDF2.
    ///
    /// If `salt_b64` is provided, it is decoded as Base64 and used as the PBKDF2 salt.
    /// Otherwise a random 16-byte salt is generated. Call `export_salt()` to persist it.
    pub fn init(&mut self, passphrase: &str) {
        self.init_with_salt(passphrase, None).expect("init with random salt should not fail");
    }

    /// Initialize with a passphrase and an explicit Base64-encoded salt.
    /// Call `export_salt()` to persist the salt for future re-derivation.
    pub fn init_with_salt(&mut self, passphrase: &str, salt_b64: Option<&str>) -> Result<(), String> {
        let salt_bytes = match salt_b64 {
            Some(s) => BASE64.decode(s).map_err(|e| format!("invalid base64 salt: {}", e))?,
            None => {
                let mut s = vec![0u8; SALT_LENGTH];
                OsRng.fill_bytes(&mut s);
                s
            }
        };
        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), &salt_bytes, 100_000, &mut key);
        self.salt = Some(salt_bytes);
        self.master_key = Some(key);

        // Generate ECDH keypair
        let secret = EphemeralSecret::random(&mut OsRng);
        let public = PublicKey::from(&secret);
        self.public_key_bytes = Some(public.to_sec1_bytes().to_vec());
        self.private_key = Some(secret);
        Ok(())
    }

    /// Export the PBKDF2 salt as Base64 for persistent storage.
    pub fn export_salt(&self) -> Option<String> {
        self.salt.as_ref().map(|s| BASE64.encode(s))
    }

    /// Export the public key as base64 for sharing with peers.
    pub fn export_public_key(&self) -> Option<String> {
        self.public_key_bytes.as_ref().map(|bytes| BASE64.encode(bytes))
    }

    /// Set a pre-shared session key for a conversation.
    pub fn set_session_key(&mut self, conversation_id: &str, key: [u8; 32]) {
        self.session_keys.insert(conversation_id.to_string(), key);
    }

    /// Generate a random session key for a conversation.
    pub fn generate_session_key(&mut self, conversation_id: &str) -> [u8; 32] {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        self.session_keys.insert(conversation_id.to_string(), key);
        key
    }

    /// Encrypt plaintext for a conversation. Returns base64(IV + ciphertext).
    pub fn encrypt(&self, conversation_id: &str, plaintext: &str) -> Result<String, String> {
        let key = self.session_keys.get(conversation_id)
            .ok_or_else(|| format!("No session key for conversation: {}", conversation_id))?;

        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| format!("Cipher init failed: {}", e))?;

        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);

        let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| format!("Encryption failed: {}", e))?;

        // Prepend IV to ciphertext, then base64 encode
        let mut combined = Vec::with_capacity(12 + ciphertext.len());
        combined.extend_from_slice(&iv);
        combined.extend_from_slice(&ciphertext);

        Ok(BASE64.encode(&combined))
    }

    /// Decrypt base64(IV + ciphertext) for a conversation.
    pub fn decrypt(&self, conversation_id: &str, encrypted: &str) -> Result<String, String> {
        let key = self.session_keys.get(conversation_id)
            .ok_or_else(|| format!("No session key for conversation: {}", conversation_id))?;

        let combined = BASE64.decode(encrypted)
            .map_err(|e| format!("Base64 decode failed: {}", e))?;

        if combined.len() < 13 {
            return Err("Ciphertext too short".to_string());
        }

        let (iv, ciphertext) = combined.split_at(12);
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|e| format!("Cipher init failed: {}", e))?;
        let nonce = Nonce::from_slice(iv);

        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| format!("Decryption failed: {}", e))?;

        String::from_utf8(plaintext).map_err(|e| format!("UTF-8 decode failed: {}", e))
    }

    /// Check if encryption is initialized.
    pub fn is_initialized(&self) -> bool {
        self.master_key.is_some()
    }

    /// Check if a conversation has a session key.
    pub fn has_session_key(&self, conversation_id: &str) -> bool {
        self.session_keys.contains_key(conversation_id)
    }
}

impl Default for E2EEncryption {
    fn default() -> Self {
        Self::new()
    }
}
