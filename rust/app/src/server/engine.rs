//! The audio engine the Rust core runs on until B4 (rust/DECISIONS.md ADR-015, ADR-018).
//!
//! It plays nothing, and says so: it answers exactly as the original's `AudioPlaybackManager`
//! does on a machine where the output device can't be opened. `init()` succeeds there (the stream
//! only opens on the first play), every play then fails with the device error, a reopen after a
//! settings change fails the same way, and stopping, pausing and status find nothing playing. The
//! error text names the real reason instead of a device message (ADR-005: error text is free).

use serde_json::{Value, json};

use crate::core::cue_engine::{AudioEngine, EngineEvent};
use crate::core::jsv::{self, Obj};

/// What every play and reopen answers until B4.
pub const NO_OUTPUT: &str = "No audio output: the Rust audio engine (B4) is not built yet";

pub struct NoOutputEngine {
    initialized: bool,
    init_error: Option<String>,
    sample_rate: Value,
    buffer_size: Value,
    channel_count: Value,
    device: Value,
    master: f64,
}

impl Default for NoOutputEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl NoOutputEngine {
    pub fn new() -> Self {
        NoOutputEngine {
            initialized: false,
            init_error: None,
            sample_rate: json!(48000),
            buffer_size: json!(512),
            channel_count: json!(2),
            device: json!("default"),
            master: 1.0,
        }
    }

    /// `_applyConfigValues`: rate and buffer `|| default`, channels clamped to what the device
    /// offers (with no device known, the original's fallback is 2).
    fn apply_values(&mut self, config: &Value) {
        self.sample_rate = jsv::or(config.get("audioSampleRate"), json!(48000));
        self.buffer_size = jsv::or(config.get("audioBufferSize"), json!(512));
        let requested = jsv::to_number(&jsv::or(config.get("audioOutputChannelCount"), json!(2)));
        self.channel_count = jsv::num(if requested.is_nan() {
            1.0
        } else {
            requested.clamp(1.0, 2.0)
        });
        self.device = jsv::or(config.get("audioOutputDeviceId"), json!("default"));
    }
}

impl AudioEngine for NoOutputEngine {
    fn init(&mut self, config: &Value) {
        self.apply_values(config);
        self.initialized = true;
        self.init_error = None;
    }
    fn set_playback_end_callback(&mut self) {}
    fn set_playback_advance_callback(&mut self) {}
    fn set_engine_error_callback(&mut self) {}
    fn is_initialized(&self) -> bool {
        self.initialized
    }
    fn playing_cue_ids(&self) -> Vec<String> {
        Vec::new()
    }
    fn is_playing(&self, _cue_id: &str) -> bool {
        false
    }
    fn apply_audio_config(&mut self, config: &Value) -> Value {
        let before = (
            self.device.clone(),
            self.channel_count.clone(),
            self.sample_rate.clone(),
            self.buffer_size.clone(),
        );
        self.apply_values(config);
        let after = (
            self.device.clone(),
            self.channel_count.clone(),
            self.sample_rate.clone(),
            self.buffer_size.clone(),
        );
        if self.initialized && before == after {
            return json!({ "success": true, "unchanged": true });
        }
        // The reopen fails: there is no output to open.
        self.initialized = false;
        self.init_error = Some(NO_OUTPUT.to_string());
        json!({ "success": false, "error": NO_OUTPUT })
    }
    fn play_cue(&mut self, _cue_id: &str, _file_path: &Value, _options: &Value) -> Value {
        if !self.initialized {
            let error = self
                .init_error
                .clone()
                .unwrap_or_else(|| "Audio engine not initialized".to_string());
            return json!({ "success": false, "error": error });
        }
        // `ensureStreamOpen()` throws on a device that can't be opened; caught.
        json!({ "success": false, "error": NO_OUTPUT })
    }
    fn stop_cue(&mut self, _cue_id: &str, _fade_out: bool, _seconds: f64) -> Value {
        json!({ "success": true, "fading": false })
    }
    fn stop_all_cues(&mut self, _fade_out: bool, _seconds: Option<f64>) -> Value {
        json!({ "success": true, "results": [] })
    }
    fn pause_cue(&mut self, _cue_id: &str) -> Value {
        json!({ "success": false, "error": "Cue not playing" })
    }
    fn resume_cue(&mut self, _cue_id: &str) -> Value {
        json!({ "success": false, "error": "Cue not paused" })
    }
    fn set_cue_volume(&mut self, _cue_id: &str, _volume: &Value) {}
    fn set_cue_duck(&mut self, _cue_id: &str, _multiplier: f64, _seconds: f64) {}
    fn set_master_volume(&mut self, volume: f64) {
        // `Math.max(0, Math.min(2, Number(volume)))`: NaN stays NaN.
        self.master = if volume.is_nan() {
            f64::NAN
        } else {
            volume.clamp(0.0, 2.0)
        };
    }
    fn master_volume(&self) -> f64 {
        self.master
    }
    fn voice_count(&self, _cue_id: &str) -> usize {
        0
    }
    fn clear_next(&mut self, _cue_id: &str) {}
    fn queue_next(
        &mut self,
        _cue_id: &str,
        _file_path: &Value,
        _options: &Value,
        _still_wanted: &mut dyn FnMut() -> bool,
    ) -> bool {
        false
    }
    fn forget_buffer(&mut self, _path: &Value) {}
    fn voices(&self) -> Vec<Value> {
        Vec::new()
    }
    fn drain_peak_levels(&mut self) -> Obj {
        Obj::new()
    }
    fn device_id(&self) -> Value {
        // RtAudio's numeric id of the resolved device; there is none.
        Value::Null
    }
    fn sample_rate(&self) -> Value {
        self.sample_rate.clone()
    }
    fn channel_count(&self) -> Value {
        self.channel_count.clone()
    }
    fn cleanup(&mut self) {
        self.initialized = false;
    }
    fn take_events(&mut self) -> Vec<EngineEvent> {
        Vec::new()
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
