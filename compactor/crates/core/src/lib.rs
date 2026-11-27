//! What the compactor and the trust plugins share: the configuration, the database, Redis, the
//! object store and the formats stored in them.
//!
//! The API (src/, TypeScript) reads and writes the same stores. Each format is kept on both
//! sides, and the files under `fixtures/` hold the two together: the TypeScript tests and the
//! tests of this crate read the same ones.

pub mod attestation;
pub mod azure;
pub mod comments;
pub mod config;
pub mod content;
pub mod counts;
pub mod db;
pub mod format;
pub mod hot;
pub mod inbox;
pub mod json;
pub mod layout;
pub mod log;
pub mod object;
pub mod origin_keys;
pub mod pending;
pub mod posts;
pub mod probe;
pub mod public_fetch;
pub mod quarantine;
pub mod reposts;
pub mod search;
pub mod stores;
pub mod summary;
pub mod tags;
#[cfg(feature = "testing")]
pub mod testing;
pub mod text;
pub mod time;
pub mod util;
