//! The core, one module per manager of the original (ADR-015). Stage B1: the data layer.

pub mod audio_files;
pub mod bundle;
pub mod config;
pub mod cues;
pub mod jsv;
pub mod library;
pub mod nodefs;
pub mod paths;
pub mod probe;

// Wave A ports, used as they are (their crates keep the napi bindings and the proof).
#[path = "../../../cue-aliases/src/port.rs"]
pub mod cue_aliases;
#[path = "../../../id-validation/src/port.rs"]
pub mod id_validation;
#[path = "../../../media-library-names/src/port.rs"]
pub mod media_names;
#[path = "../../../output-patch/src/port.rs"]
pub mod output_patch;
