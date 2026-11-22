//! The fakes the B3 differential check runs the cue engine against: an audio engine that logs
//! every call and plays nothing, and a broadcaster that collects messages. They mirror
//! `rust/scripts/cue-engine-fakes.js` (the Node side) call for call; keep the two in step.

use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::core::cue_engine::{AudioEngine, Broadcaster, EngineEvent, num};
use crate::core::jsv::{self, Obj};
use crate::js;

/// What a fake writes to its log: one JSON value per call, shared with the driver.
pub type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Clone)]
struct Voice {
    voice_id: u64,
    started_at: f64,
    volume: Value,
    duck_gain: f64,
    paused: bool,
    fading_out: bool,
    fade_in_until: f64,
    trim_start: f64,
    trim_end: Value,
    output_patch: Value,
}

pub struct FakeEngine {
    pub log: Log,
    pub script: Arc<Mutex<Vec<(String, Value)>>>,
    now: Box<dyn Fn() -> f64 + Send>,
    voices: IndexMap<String, Vec<Voice>>,
    last_token: IndexMap<String, Value>,
    voice_seq: u64,
    master: f64,
    events: Vec<EngineEvent>,
}

fn n(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, jsv::to_number)
}

impl FakeEngine {
    pub fn new(
        log: Log,
        script: Arc<Mutex<Vec<(String, Value)>>>,
        now: Box<dyn Fn() -> f64 + Send>,
    ) -> Self {
        FakeEngine {
            log,
            script,
            now,
            voices: IndexMap::new(),
            last_token: IndexMap::new(),
            voice_seq: 0,
            master: 1.0,
            events: Vec::new(),
        }
    }

    fn push(&self, v: Value) {
        if let Ok(mut l) = self.log.lock() {
            l.push(v);
        }
    }

    fn scripted(&self, method: &str) -> Option<Value> {
        let mut s = self.script.lock().ok()?;
        let i = s.iter().position(|(m, _)| m == method)?;
        Some(s.remove(i).1)
    }

    fn all_paused(list: &[Voice]) -> bool {
        list.iter().all(|v| v.paused)
    }

    /// The "audio thread" ending a cue (`engine.end`).
    pub fn end(&mut self, cue_id: &str, reason: &Value) {
        self.voices.shift_remove(cue_id);
        self.events.push(EngineEvent::PlaybackEnd {
            cue_id: cue_id.to_string(),
            reason: if js::is_undefined(reason) {
                "completed".into()
            } else {
                jsv::to_js_string(reason)
            },
        });
    }

    /// A playlist moving on into its queued item (`engine.advance`).
    pub fn advance(&mut self, cue_id: &str, token: Option<&Value>) {
        let token = match token {
            Some(t) if !t.is_null() && !js::is_undefined(t) => t.clone(),
            _ => self.last_token.get(cue_id).cloned().unwrap_or(Value::Null),
        };
        self.events.push(EngineEvent::Advance {
            cue_id: cue_id.to_string(),
            token,
        });
    }

    pub fn error(&mut self, payload: Value) {
        self.events.push(EngineEvent::Error(payload));
    }
}

impl AudioEngine for FakeEngine {
    fn init(&mut self, config: &Value) {
        self.push(json!({ "m": "init", "args": [config] }));
    }
    fn set_playback_end_callback(&mut self) {
        self.push(json!({ "m": "setPlaybackEndCallback" }));
    }
    fn set_playback_advance_callback(&mut self) {
        self.push(json!({ "m": "setPlaybackAdvanceCallback" }));
    }
    fn set_engine_error_callback(&mut self) {
        self.push(json!({ "m": "setEngineErrorCallback" }));
    }
    fn is_initialized(&self) -> bool {
        true
    }
    fn playing_cue_ids(&self) -> Vec<String> {
        self.voices.keys().cloned().collect()
    }
    fn is_playing(&self, cue_id: &str) -> bool {
        self.voices.contains_key(cue_id)
    }
    fn apply_audio_config(&mut self, config: &Value) -> Value {
        self.push(json!({ "m": "applyAudioConfig", "args": [config] }));
        self.scripted("applyAudioConfig")
            .unwrap_or_else(|| json!({ "success": true, "unchanged": false }))
    }
    fn play_cue(&mut self, cue_id: &str, file_path: &Value, options: &Value) -> Value {
        self.push(json!({ "m": "playCue", "args": [cue_id, file_path, options] }));
        if let Some(s) = self.scripted("playCue") {
            return s;
        }
        if !jsv::truthy_opt(options.get("newInstance")) {
            self.voices.shift_remove(cue_id);
        }
        let now = (self.now)();
        self.voice_seq += 1;
        let trim_end = match options.get("trimEndTime") {
            Some(v) if !v.is_null() && !js::is_undefined(v) => v.clone(),
            _ => json!(10),
        };
        let voice = Voice {
            voice_id: self.voice_seq,
            started_at: now,
            volume: options.get("volume").cloned().unwrap_or(Value::Null),
            duck_gain: n(options.get("duckGain")),
            paused: false,
            fading_out: false,
            fade_in_until: now + n(options.get("fadeInTime")) * 1000.0,
            trim_start: n(options.get("trimStartTime")),
            trim_end,
            output_patch: match options.get("outputPatch") {
                Some(v) if !js::is_undefined(v) => v.clone(),
                _ => Value::Null,
            },
        };
        let id = voice.voice_id;
        self.voices
            .entry(cue_id.to_string())
            .or_default()
            .push(voice);
        json!({ "success": true, "voiceId": id })
    }
    fn stop_cue(&mut self, cue_id: &str, fade_out: bool, seconds: f64) -> Value {
        self.push(json!({ "m": "stopCue", "args": [cue_id, fade_out, num(seconds)] }));
        if let Some(s) = self.scripted("stopCue") {
            return s;
        }
        let Some(list) = self.voices.get_mut(cue_id) else {
            return json!({ "success": true, "fading": false });
        };
        if fade_out && seconds > 0.0 && !Self::all_paused(list) {
            list.iter_mut().for_each(|v| v.fading_out = true);
            return json!({ "success": true, "fading": true });
        }
        self.voices.shift_remove(cue_id);
        json!({ "success": true, "fading": false })
    }
    fn stop_all_cues(&mut self, fade_out: bool, seconds: Option<f64>) -> Value {
        self.push(
            json!({ "m": "stopAllCues", "args": [fade_out, seconds.map_or(Value::Null, num)] }),
        );
        if let Some(s) = self.scripted("stopAllCues") {
            return s;
        }
        let mut results = Vec::new();
        let ids: Vec<String> = self.voices.keys().cloned().collect();
        for id in ids {
            let list = &self.voices[&id];
            let fading = fade_out && seconds.is_some_and(|s| s > 0.0) && !Self::all_paused(list);
            if fading {
                if let Some(l) = self.voices.get_mut(&id) {
                    l.iter_mut().for_each(|v| v.fading_out = true);
                }
            } else {
                self.voices.shift_remove(&id);
            }
            results.push(json!({ "cueId": id, "fading": fading }));
        }
        json!({ "success": true, "results": results })
    }
    fn pause_cue(&mut self, cue_id: &str) -> Value {
        self.push(json!({ "m": "pauseCue", "args": [cue_id] }));
        if let Some(s) = self.scripted("pauseCue") {
            return s;
        }
        match self.voices.get_mut(cue_id) {
            Some(list) if !Self::all_paused(list) => {
                list.iter_mut().for_each(|v| v.paused = true);
                json!({ "success": true })
            }
            _ => json!({ "success": false, "error": "Cue not playing" }),
        }
    }
    fn resume_cue(&mut self, cue_id: &str) -> Value {
        self.push(json!({ "m": "resumeCue", "args": [cue_id] }));
        if let Some(s) = self.scripted("resumeCue") {
            return s;
        }
        let now = (self.now)();
        match self.voices.get_mut(cue_id) {
            Some(list) if list.iter().any(|v| v.paused) => {
                for v in list.iter_mut() {
                    v.paused = false;
                    v.started_at = now;
                }
                json!({ "success": true })
            }
            _ => json!({ "success": false, "error": "Cue not paused" }),
        }
    }
    fn set_cue_volume(&mut self, cue_id: &str, volume: &Value) {
        self.push(json!({ "m": "setCueVolume", "args": [cue_id, volume] }));
        if let Some(list) = self.voices.get_mut(cue_id) {
            list.iter_mut().for_each(|v| v.volume = volume.clone());
        }
    }
    fn set_cue_duck(&mut self, cue_id: &str, multiplier: f64, seconds: f64) {
        self.push(json!({ "m": "setCueDuck", "args": [cue_id, num(multiplier), num(seconds)] }));
        if let Some(list) = self.voices.get_mut(cue_id) {
            list.iter_mut().for_each(|v| v.duck_gain = multiplier);
        }
    }
    fn set_master_volume(&mut self, volume: f64) {
        self.push(json!({ "m": "setMasterVolume", "args": [num(volume)] }));
        self.master = volume.clamp(0.0, 2.0);
    }
    fn master_volume(&self) -> f64 {
        self.master
    }
    fn voice_count(&self, cue_id: &str) -> usize {
        self.voices.get(cue_id).map_or(0, Vec::len)
    }
    fn clear_next(&mut self, cue_id: &str) {
        self.push(json!({ "m": "clearNext", "args": [cue_id] }));
    }
    fn queue_next(
        &mut self,
        cue_id: &str,
        file_path: &Value,
        options: &Value,
        still_wanted: &mut dyn FnMut() -> bool,
    ) -> bool {
        let wanted = still_wanted();
        self.push(json!({ "m": "queueNext", "args": [cue_id, file_path, options], "stillWanted": wanted }));
        let queued = match self.scripted("queueNext") {
            Some(s) => jsv::truthy(&s),
            None => wanted,
        };
        if queued {
            self.last_token.insert(
                cue_id.to_string(),
                options.get("token").cloned().unwrap_or(Value::Null),
            );
        }
        queued
    }
    fn forget_buffer(&mut self, path: &Value) {
        let p = if js::is_undefined(path) {
            Value::Null
        } else {
            path.clone()
        };
        self.push(json!({ "m": "audioBuffers.delete", "args": [p] }));
    }
    fn voices(&self) -> Vec<Value> {
        let now = (self.now)();
        let mut out = Vec::new();
        for (cue_id, list) in &self.voices {
            for v in list {
                let volume = n(Some(&v.volume));
                let mut o = Obj::new();
                o.insert("cueId".into(), json!(cue_id));
                o.insert("voiceId".into(), json!(v.voice_id));
                o.insert("isPaused".into(), json!(v.paused));
                o.insert("isFadingIn".into(), json!(now < v.fade_in_until));
                o.insert("isFadingOut".into(), json!(v.fading_out));
                o.insert("isDucked".into(), json!(v.duck_gain < 1.0));
                o.insert("duckGain".into(), num(v.duck_gain));
                o.insert("currentGain".into(), num(volume * v.duck_gain));
                o.insert("volume".into(), v.volume.clone());
                let elapsed = if v.paused {
                    0.0
                } else {
                    (now - v.started_at) / 1000.0
                };
                o.insert("positionSec".into(), num(v.trim_start + elapsed));
                o.insert("trimStartSec".into(), num(v.trim_start));
                o.insert("trimEndSec".into(), v.trim_end.clone());
                o.insert("outputPatch".into(), v.output_patch.clone());
                let rem = (v.fade_in_until - now) / 1000.0;
                o.insert(
                    "fadeRemainingSec".into(),
                    num(if rem.is_nan() { f64::NAN } else { rem.max(0.0) }),
                );
                out.push(Value::Object(o));
            }
        }
        out
    }
    fn drain_peak_levels(&mut self) -> Obj {
        let mut o = Obj::new();
        for (id, list) in &self.voices {
            if !Self::all_paused(list) {
                o.insert(id.clone(), json!(0.5));
            }
        }
        o
    }
    fn device_id(&self) -> Value {
        json!(130)
    }
    fn sample_rate(&self) -> Value {
        json!(48000)
    }
    fn channel_count(&self) -> Value {
        json!(2)
    }
    fn cleanup(&mut self) {
        self.push(json!({ "m": "cleanup" }));
    }
    fn take_events(&mut self) -> Vec<EngineEvent> {
        std::mem::take(&mut self.events)
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

/// Collects broadcasts as `cue-engine-fakes.js`'s `makeFakeWs` does.
pub struct FakeWs {
    pub log: Log,
}

impl FakeWs {
    fn push(&self, v: Value) {
        if let Ok(mut l) = self.log.lock() {
            l.push(v);
        }
    }
}

impl Broadcaster for FakeWs {
    fn broadcast(&mut self, message: Value) {
        self.push(json!({ "m": "broadcast", "message": message }));
    }
    fn broadcast_cues_update(&mut self, cues: Vec<Value>) {
        self.push(json!({ "m": "cuesUpdate", "cues": cues }));
    }
    fn broadcast_cue_update(&mut self, cue_id: &str, updates: &Value) {
        let mut o = Obj::new();
        o.insert("m".into(), json!("cueUpdate"));
        o.insert("cueId".into(), json!(cue_id));
        o.insert("updates".into(), updates.clone());
        self.push(Value::Object(o));
    }
    fn broadcast_cue_status(&mut self, cue_id: &str, status: &str, extra: Option<Obj>) {
        let mut o = Obj::new();
        o.insert("m".into(), json!("cueStatus"));
        o.insert("cueId".into(), json!(cue_id));
        o.insert("status".into(), json!(status));
        o.insert(
            "extra".into(),
            extra.map_or_else(js::undefined, Value::Object),
        );
        self.push(Value::Object(o));
    }
    fn broadcast_workspace_update(&mut self, workspace: Value) {
        self.push(json!({ "m": "workspaceUpdate", "workspace": workspace }));
    }
}
