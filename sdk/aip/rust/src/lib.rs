//! @prismer/aip-sdk — Agent Identity Protocol for AI Agents (Rust)
//!
//! Standalone DID:key identity, delegation, and verifiable credentials.

pub mod did;
pub mod identity;

pub use did::{public_key_to_did_key, did_key_to_public_key, validate_did_key};
pub use identity::AIPIdentity;
