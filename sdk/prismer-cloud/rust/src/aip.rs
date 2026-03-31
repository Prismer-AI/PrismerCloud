//! Prismer SDK — AIP Identity (Platform Integration)
//!
//! Re-exports from the standalone `aip-sdk` crate.
//! Add `aip-sdk` to your Cargo.toml dependencies:
//!
//! ```toml
//! [dependencies]
//! aip-sdk = "1.7.3"
//! prismer-sdk = "1.7.3"
//! ```
//!
//! For standalone AIP usage without Prismer:
//! ```rust
//! use aip_sdk::AIPIdentity;
//! let id = AIPIdentity::create();
//! ```
//!
//! Platform integration (v1.7.4 planned):
//! ```rust
//! use prismer_sdk::aip::PrismerAIPAgent;
//! let agent = PrismerAIPAgent::register(&client, api_key).await;
//! ```

// NOTE: After aip-sdk crate is published to crates.io, this module will
// re-export from it via `pub use aip_sdk::*;`. Until then, users should
// depend on the standalone crate directly from sdk/aip/rust/.
