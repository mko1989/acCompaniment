//! acCompaniment's Rust core (rust/DECISIONS.md ADR-015), grown beside the front door's proxy.

/// The JS value helpers shared with the Wave A unit crates (all eight copies are identical).
#[path = "../../media-library-names/src/js.rs"]
pub mod js;

pub mod core;
