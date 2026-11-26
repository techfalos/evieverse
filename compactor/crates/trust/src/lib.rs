//! Trust: how far the server trusts what it is sent, and what that has it do.
//!
//! - `trust`: a post's trust score, worked out by plugins, and where a score sends a post.
//! - `plugins`: the plugins, one per folder of src/plugins (see build.rs).
//! - `policy`: moderation of a post, a comment, a profile and a repost: the score, and what
//!   hashtags' moderators keep (mutes, removals, blocked words).
//! - `words`: blocked words, phrases and patterns, and how a text is read for them.
//! - `patterns`: the engine blocked patterns run in.
//!
//! The API (src/, TypeScript) calls this through the addon (crates/node), and the compactor's
//! binary calls it directly, so a post is scored by the same code wherever it is scored.

pub mod lines;
pub mod patterns;
pub mod policy;
#[cfg(feature = "test-plugin")]
pub mod testing;
pub mod trust;
pub mod words;

/// The plugins: every folder of src/plugins, registered by build.rs.
pub mod plugins {
    include!(concat!(env!("OUT_DIR"), "/plugins.rs"));
}
