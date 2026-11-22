//! B4: the audio engine (rust/DECISIONS.md ADR-007, ADR-018): decoding, the PCM cache, output
//! devices and the cpal engine behind the cue engine's `AudioEngine` trait.

pub mod decode;
pub mod devices;
pub mod engine;
pub mod pcm_cache;
