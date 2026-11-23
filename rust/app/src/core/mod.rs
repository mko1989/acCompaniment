//! The core, one module per manager of the original (ADR-015): the data layer, the cue engine
//! (`cue_engine`, with `clock`), and the pure logic ported in Wave A.

pub mod audio_files;
pub mod bundle;
pub mod clock;
pub mod config;
pub mod cue_engine;
pub mod cues;
pub mod jsv;
pub mod library;
pub mod nodefs;
pub mod paths;
pub mod probe;

// Wave A ports (pure logic; their recorded cases run in tests/unit_cases.rs).
pub mod cue_aliases;
pub mod id_validation;
pub mod lru_cache;
pub mod media_names;
pub mod output_patch;
pub mod playlist_logic;
pub mod retrigger_logic;
pub mod soundboard_mixer;
