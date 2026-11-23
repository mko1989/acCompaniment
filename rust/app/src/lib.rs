//! acCompaniment's server: the HTTP and WebSocket API, the cue engine, the data layer and the audio
//! engine (rust/DECISIONS.md).

/// JS value semantics the port keeps (undefined, number formatting, sorting; ADR-005).
pub mod js;

pub mod audio;
pub mod core;
pub mod server;
