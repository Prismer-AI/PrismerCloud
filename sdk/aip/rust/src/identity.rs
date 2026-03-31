//! AIPIdentity — Ed25519 DID identity for AI Agents.

use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use data_encoding::BASE64;
use rand::rngs::OsRng;
use sha2::{Sha256, Digest};
use crate::did::{public_key_to_did_key, did_key_to_public_key};

pub struct AIPIdentity {
    pub did: String,
    pub public_key: [u8; 32],
    signing_key: SigningKey,
}

impl AIPIdentity {
    pub fn create() -> Self {
        let sk = SigningKey::generate(&mut OsRng);
        let pk = sk.verifying_key().to_bytes();
        let did = public_key_to_did_key(&pk);
        Self { did, public_key: pk, signing_key: sk }
    }

    pub fn from_api_key(api_key: &str) -> Self {
        let seed: [u8; 32] = Sha256::digest(api_key.as_bytes()).into();
        let sk = SigningKey::from_bytes(&seed);
        let pk = sk.verifying_key().to_bytes();
        let did = public_key_to_did_key(&pk);
        Self { did, public_key: pk, signing_key: sk }
    }

    pub fn from_private_key(priv_b64: &str) -> Result<Self, String> {
        let bytes = BASE64.decode(priv_b64.as_bytes()).map_err(|e| format!("decode: {}", e))?;
        if bytes.len() != 32 { return Err("invalid key length".into()); }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&bytes);
        let sk = SigningKey::from_bytes(&seed);
        let pk = sk.verifying_key().to_bytes();
        let did = public_key_to_did_key(&pk);
        Ok(Self { did, public_key: pk, signing_key: sk })
    }

    pub fn public_key_base64(&self) -> String { BASE64.encode(&self.public_key) }

    pub fn sign(&self, data: &[u8]) -> String {
        BASE64.encode(&self.signing_key.sign(data).to_bytes())
    }

    pub fn verify(data: &[u8], sig_b64: &str, signer_did: &str) -> bool {
        let pk = match did_key_to_public_key(signer_did) { Ok(p) => p, Err(_) => return false };
        let sig_bytes = match BASE64.decode(sig_b64.as_bytes()) { Ok(b) => b, Err(_) => return false };
        if sig_bytes.len() != 64 { return false; }
        let mut arr = [0u8; 64];
        arr.copy_from_slice(&sig_bytes);
        let sig = Signature::from_bytes(&arr);
        match VerifyingKey::from_bytes(&pk) {
            Ok(vk) => vk.verify(data, &sig).is_ok(),
            Err(_) => false,
        }
    }

    pub fn export_private_key(&self) -> String { BASE64.encode(&self.signing_key.to_bytes()) }
}
