//! The core, one module per manager of the original (ADR-015). B1: the data layer; B3: the cue
//! engine (`cue_engine`, with `clock` and the differential check's `cue_fakes`).

pub mod audio_files;
pub mod bundle;
pub mod clock;
pub mod config;
pub mod cue_engine;
pub mod cue_fakes;
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
#[path = "../../../playlist-logic/src/port.rs"]
pub mod playlist_logic;
#[path = "../../../retrigger-logic/src/port.rs"]
pub mod retrigger_logic;
