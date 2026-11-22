//! The cue engine (B3, rust/DECISIONS.md ADR-015): a port of `src/backend/cueManager.js`, on the
//! B1 data layer, in the same structure and the same order of side effects.
//!
//! Differences that come from Rust, not from behavior:
//! - The original is async; this is synchronous. Its per-cue operation queue (`_serialized`)
//!   becomes "one operation at a time" (B2 holds the core behind one lock). Engine events (item
//!   ended, playlist advanced, engine error) arrive as `EngineEvent`s that `pump_engine_events`
//!   handles between operations, as the original handles its callbacks between awaits.
//! - `_queueNextItem` is started without being awaited in the original: its first part runs at
//!   once, the rest (after looking up the next file) later. Here the rest is a `Deferred` that runs
//!   when the current operation is done (`run_deferred`), which is where the original's runs too.
//! - Time is a `Clock`: `Date.now()`, the debounced save and the 100 ms playback-time broadcast.

use std::collections::VecDeque;

use indexmap::IndexMap;
use serde_json::{Value, json};

use crate::core::audio_files::AudioFileManager;
use crate::core::clock::{Clock, TimerKind};
use crate::core::cues::CueDataManager;
use crate::core::jsv::{self, Obj};
use crate::core::{library, nodefs as nfs, playlist_logic, retrigger_logic};
use crate::js;

/// How long ducking takes to lower / restore affected cues (legacy app: 1s).
const DEFAULT_DUCK_FADE_MS: f64 = 1000.0;
const AUDIO_ENGINE_CONFIG_KEYS: [&str; 4] = [
    "audioOutputDeviceId",
    "audioOutputChannelCount",
    "audioSampleRate",
    "audioBufferSize",
];

fn spotify_removed() -> Value {
    json!({ "success": false, "error": "Spotify cues are no longer supported" })
}

/// What the audio engine reports back: the three callbacks the original registers.
#[derive(Clone, Debug)]
pub enum EngineEvent {
    /// `setPlaybackEndCallback`: a cue's last voice ended (`completed`) or faded out (`stopped`).
    PlaybackEnd { cue_id: String, reason: String },
    /// `setPlaybackAdvanceCallback`: a playlist moved on into its queued next item.
    Advance { cue_id: String, token: Value },
    /// `setEngineErrorCallback`.
    Error(Value),
}

/// The `AudioPlaybackManager` surface `cueManager.js` uses, call for call. Results are the
/// original's result objects. B4 implements it on cpal; `cue_fakes::FakeEngine` records calls.
pub trait AudioEngine {
    fn init(&mut self, config: &Value);
    fn set_playback_end_callback(&mut self);
    fn set_playback_advance_callback(&mut self);
    fn set_engine_error_callback(&mut self);
    fn is_initialized(&self) -> bool;
    /// `playingCues.keys()`, in the engine's order.
    fn playing_cue_ids(&self) -> Vec<String>;
    fn is_playing(&self, cue_id: &str) -> bool;
    fn apply_audio_config(&mut self, config: &Value) -> Value;
    fn play_cue(&mut self, cue_id: &str, file_path: &Value, options: &Value) -> Value;
    fn stop_cue(&mut self, cue_id: &str, fade_out: bool, seconds: f64) -> Value;
    fn stop_all_cues(&mut self, fade_out: bool, seconds: Option<f64>) -> Value;
    fn pause_cue(&mut self, cue_id: &str) -> Value;
    fn resume_cue(&mut self, cue_id: &str) -> Value;
    fn set_cue_volume(&mut self, cue_id: &str, volume: &Value);
    fn set_cue_duck(&mut self, cue_id: &str, multiplier: f64, seconds: f64);
    fn set_master_volume(&mut self, volume: f64);
    fn master_volume(&self) -> f64;
    fn voice_count(&self, cue_id: &str) -> usize;
    fn clear_next(&mut self, cue_id: &str);
    /// `queueNext(cueId, filePath, opts, stillWanted)`: `still_wanted` answers whether the item
    /// is still the one to queue (the original passes a closure the engine calls).
    fn queue_next(
        &mut self,
        cue_id: &str,
        file_path: &Value,
        options: &Value,
        still_wanted: &mut dyn FnMut() -> bool,
    ) -> bool;
    /// `audioBuffers.delete(path)`.
    fn forget_buffer(&mut self, path: &Value);
    /// `mixer.getStatus().playing` (and `getPlaybackStatus().mixer.playing`).
    fn voices(&self) -> Vec<Value>;
    fn drain_peak_levels(&mut self) -> Obj;
    fn device_id(&self) -> Value;
    fn sample_rate(&self) -> Value;
    fn channel_count(&self) -> Value;
    fn cleanup(&mut self);
    fn take_events(&mut self) -> Vec<EngineEvent>;
    /// For the differential check's driver, to reach its fake engine.
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}

/// The `WebSocketManager` calls the cue manager makes.
pub trait Broadcaster {
    fn broadcast(&mut self, message: Value);
    fn broadcast_cues_update(&mut self, cues: Vec<Value>);
    fn broadcast_cue_update(&mut self, cue_id: &str, updates: &Value);
    fn broadcast_cue_status(&mut self, cue_id: &str, status: &str, extra: Option<Obj>);
    fn broadcast_workspace_update(&mut self, workspace: Value);
}

/// `decideItemEnd`'s answer.
#[derive(Clone, Debug)]
pub struct Decision {
    pub action: &'static str,
    pub next_index: Option<f64>,
    /// The order to keep (a JS array value), or `None` (`order: null`).
    pub order: Option<Value>,
}

impl Decision {
    fn to_value(&self) -> Value {
        let mut o = Obj::new();
        o.insert("action".into(), json!(self.action));
        o.insert("nextIndex".into(), opt_num(self.next_index));
        o.insert("order".into(), self.order.clone().unwrap_or(Value::Null));
        Value::Object(o)
    }
}

#[derive(Clone, Debug)]
pub struct Queued {
    pub token: f64,
    pub decision: Decision,
}

/// The part of `_queueNextItem` that runs after its first `await`.
enum Deferred {
    QueueNext {
        cue_id: String,
        token: f64,
        decision: Decision,
        item: Value,
        from_index: Value,
    },
}

/// A JS number as `JSON.stringify` writes it: NaN and infinities are `null`.
pub fn num(f: f64) -> Value {
    if !f.is_finite() {
        Value::Null
    } else if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

fn opt_num(f: Option<f64>) -> Value {
    f.map_or_else(js::undefined, num)
}

/// `Math.max` / `Math.min` (NaN wins).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `a === b` for JSON values (`None` is `undefined`).
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    let a = a.filter(|v| !js::is_undefined(v));
    let b = b.filter(|v| !js::is_undefined(v));
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Object(_)), _) | (_, Some(Value::Object(_))) => false,
        (Some(Value::Array(_)), _) | (_, Some(Value::Array(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `x ?? y`.
fn nullish(x: Option<&Value>, y: Value) -> Value {
    match x {
        Some(v) if !v.is_null() && !js::is_undefined(v) => v.clone(),
        _ => y,
    }
}

fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|v| !js::is_undefined(v))
}

/// A JS number from a value used as one (`Number(x)` for what reaches arithmetic).
fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(v) if js::is_undefined(v) => f64::NAN,
        Some(v) => jsv::to_number(v),
    }
}

/// `x || 0` as a number.
fn num_or0(v: Option<&Value>) -> Value {
    jsv::or(v, json!(0))
}

/// `array[index]` for a JS array value and an index value.
fn at<'a>(array: Option<&'a Value>, index: &Value) -> Option<&'a Value> {
    let items = array?.as_array()?;
    let i = index.as_f64()?;
    if i >= 0.0 && i.fract() == 0.0 {
        items.get(i as usize).filter(|v| !js::is_undefined(v))
    } else {
        None
    }
}

fn items_len(cue: &Value) -> usize {
    get(cue, "playlistItems")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

fn is_playlist(cue: &Value) -> bool {
    get(cue, "type").and_then(Value::as_str) == Some("playlist")
}

/// JS `String.prototype.trim`.
fn js_trim(s: &str) -> String {
    let ws = |c: char| {
        matches!(c as u32, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029
            | 0x202f | 0x205f | 0x3000 | 0xfeff)
    };
    s.trim_matches(ws).to_string()
}

/// `s.slice(0, n)` in UTF-16 code units.
fn slice_units(s: &str, n: usize) -> Value {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n {
        return json!(s);
    }
    js::utf16_string(&units[..n])
}

fn order_vec(order: Option<&Value>) -> Option<Vec<f64>> {
    order?.as_array()?.iter().map(js::as_number).collect()
}

fn order_value(order: &[Option<f64>]) -> Value {
    Value::Array(
        order
            .iter()
            .map(|x| x.map_or_else(js::undefined, num))
            .collect(),
    )
}

fn obj(v: Value) -> Obj {
    match v {
        Value::Object(o) => o,
        _ => Obj::new(),
    }
}

fn success(v: &Value) -> bool {
    jsv::truthy_opt(v.get("success"))
}

pub struct CueManager {
    pub afm: AudioFileManager,
    pub cdm: CueDataManager,
    pub ws: Box<dyn Broadcaster>,
    pub engine: Box<dyn AudioEngine>,
    /// cueId -> what `startCuePlayback` answered (`{ success, playbackInfo }`).
    pub playing_cues: IndexMap<String, Obj>,
    /// cueId -> live state (`status`, `startTime`, ...).
    pub cue_states: IndexMap<String, Obj>,
    pub config: Value,
    pub crossfade_mode: bool,
    pub shuffle_orders: IndexMap<String, Value>,
    pub queued_next: IndexMap<String, Queued>,
    pub queue_token: f64,
    pub duck_state: IndexMap<String, f64>,
    pub rng: Box<dyn FnMut() -> f64 + Send>,
    pub clock: Clock,
    save_debounce_timer: Option<u64>,
    playback_time_interval: Option<u64>,
    save_debounce_ms: f64,
    pcm_cache_dir: Value,
    deferred: VecDeque<Deferred>,
}

impl CueManager {
    pub fn new(
        afm: AudioFileManager,
        cdm: CueDataManager,
        ws: Box<dyn Broadcaster>,
        engine: Box<dyn AudioEngine>,
        pcm_cache_dir: &str,
        clock: Clock,
    ) -> Self {
        CueManager {
            afm,
            cdm,
            ws,
            engine,
            playing_cues: IndexMap::new(),
            cue_states: IndexMap::new(),
            config: Value::Null,
            crossfade_mode: false,
            shuffle_orders: IndexMap::new(),
            queued_next: IndexMap::new(),
            queue_token: 0.0,
            duck_state: IndexMap::new(),
            rng: Box::new(rand_unit),
            clock,
            save_debounce_timer: None,
            playback_time_interval: None,
            save_debounce_ms: 300.0,
            pcm_cache_dir: json!(pcm_cache_dir),
            deferred: VecDeque::new(),
        }
    }

    fn now(&self) -> f64 {
        self.clock.now()
    }

    fn cfg(&self, key: &str) -> Option<&Value> {
        get(&self.config, key)
    }

    // --- Lifecycle ------------------------------------------------------------------------

    pub fn initialize(&mut self) -> Result<(), String> {
        let _ = self.cdm.cleanup_orphan_workspace_files();
        // Reopen the project that was open last; failing that the most recently changed one.
        let workspaces = self.cdm.get_all_workspaces(false);
        let last_opened = self.cfg("lastOpenedProjectId").cloned();
        let to_open = workspaces
            .iter()
            .find(|w| strict_eq(w.get("id"), last_opened.as_ref()))
            .or(workspaces.first())
            .cloned();
        match to_open {
            Some(w) => {
                let id = w.get("id").cloned().unwrap_or(Value::Null);
                self.cdm.load_workspace(&id);
            }
            None => {
                self.cdm
                    .create_workspace(Some(&json!("Default Workspace")), None, &json!({}))
                    .map_err(|e| e.to_string())?;
            }
        }
        let config = self.audio_engine_config();
        self.engine.init(&config);
        self.engine.set_playback_end_callback();
        self.engine.set_playback_advance_callback();
        self.engine.set_engine_error_callback();
        self.start_playback_time_broadcast();
        Ok(())
    }

    fn audio_engine_config(&self) -> Value {
        json!({
            "audioOutputDeviceId": nullish(self.cfg("audioOutputDeviceId"), json!("default")),
            "audioOutputChannelCount": nullish(self.cfg("audioOutputChannelCount"), json!(2)),
            "audioSampleRate": nullish(self.cfg("audioSampleRate"), json!(48000)),
            "audioBufferSize": nullish(self.cfg("audioBufferSize"), json!(512)),
            "pcmCacheDir": self.pcm_cache_dir.clone(),
        })
    }

    fn format_time_mmss(seconds: f64) -> String {
        let s0 = if seconds.is_nan() || seconds == 0.0 {
            0.0
        } else {
            seconds
        };
        let sec = js_max(0.0, s0.floor());
        let m = (sec / 60.0).floor();
        let s = sec % 60.0;
        format!(
            "{:0>2}:{:0>2}",
            js::number_to_string(m),
            js::number_to_string(s)
        )
    }

    fn start_playback_time_broadcast(&mut self) {
        if let Some(id) = self.playback_time_interval.take() {
            self.clock.clear(id);
        }
        self.playback_time_interval = Some(self.clock.set_interval(TimerKind::PlaybackTime, 100.0));
    }

    fn playback_time_tick(&mut self) {
        if !self.engine.is_initialized() {
            return;
        }
        let playing = self.engine.voices();
        let peak_levels = self.engine.drain_peak_levels();
        // One update per cue; with layered voices the newest one drives the display.
        let mut newest: IndexMap<String, Value> = IndexMap::new();
        let mut counts: IndexMap<String, usize> = IndexMap::new();
        for entry in playing {
            let id = jsv::to_js_string(entry.get("cueId").unwrap_or(&Value::Null));
            *counts.entry(id.clone()).or_insert(0) += 1;
            newest.insert(id, entry);
        }
        for (cue_id, entry) in newest {
            let cue = self.get_cue(&cue_id);
            let f = |k: &str| number(entry.get(k));
            let total_time = f("trimEndSec") - f("trimStartSec");
            let current_time = js_max(0.0, f("positionSec") - f("trimStartSec"));
            let remaining = js_max(0.0, total_time - current_time);
            let paused = jsv::truthy_opt(entry.get("isPaused"));
            let mut p = Obj::new();
            p.insert(
                "cueId".into(),
                entry.get("cueId").cloned().unwrap_or(Value::Null),
            );
            p.insert(
                "cueName".into(),
                jsv::or(cue.as_ref().and_then(|c| get(c, "name")), json!("")),
            );
            p.insert("currentTimeSec".into(), num(current_time));
            p.insert("totalDurationSec".into(), num(total_time));
            p.insert("remainingTimeSec".into(), num(remaining));
            p.insert(
                "currentTimeFormatted".into(),
                json!(Self::format_time_mmss(current_time)),
            );
            p.insert(
                "totalDurationFormatted".into(),
                json!(Self::format_time_mmss(total_time)),
            );
            p.insert(
                "remainingTimeFormatted".into(),
                json!(Self::format_time_mmss(remaining)),
            );
            p.insert(
                "status".into(),
                json!(if paused { "paused" } else { "playing" }),
            );
            p.insert(
                "peakLevel".into(),
                if paused {
                    json!(0)
                } else {
                    jsv::or(peak_levels.get(&cue_id), json!(0))
                },
            );
            p.insert(
                "isFadingIn".into(),
                json!(jsv::truthy_opt(entry.get("isFadingIn"))),
            );
            p.insert(
                "isFadingOut".into(),
                json!(jsv::truthy_opt(entry.get("isFadingOut"))),
            );
            let fade = number(Some(&jsv::or(entry.get("fadeRemainingSec"), json!(0))));
            p.insert(
                "fadeTimeRemainingMs".into(),
                num(js::math_round(fade * 1000.0)),
            );
            p.insert(
                "isDucked".into(),
                json!(jsv::truthy_opt(entry.get("isDucked"))),
            );
            p.insert("duckGain".into(), nullish(entry.get("duckGain"), json!(1)));
            p.insert(
                "voiceCount".into(),
                json!(counts.get(&cue_id).copied().unwrap_or(0)),
            );
            if let Some(cue) = &cue {
                for (k, v) in self.playlist_position(cue) {
                    p.insert(k, v);
                }
            }
            self.ws
                .broadcast(json!({ "type": "playback-time-update", "payload": p }));
        }
    }

    /// Every cue making (or, paused, holding) sound.
    fn active_cue_ids(&self) -> Vec<String> {
        self.engine.playing_cue_ids()
    }

    pub fn get_config(&self) -> &Value {
        &self.config
    }

    pub fn set_config(&mut self, config: Value) {
        self.config = config;
    }

    /// `applyConfig(prevConfig, nextConfig)`.
    pub fn apply_config(&mut self, prev: &Value, next: Value) -> Value {
        self.set_config(next);
        let changed = AUDIO_ENGINE_CONFIG_KEYS
            .iter()
            .any(|k| !strict_eq(get(prev, k), get(&self.config, k)));
        if !changed {
            return json!({ "success": true, "unchanged": true });
        }
        self.apply_audio_engine_config()
    }

    pub fn apply_audio_engine_config(&mut self) -> Value {
        if !self.engine.playing_cue_ids().is_empty() {
            self.stop_all_cues(Some(&json!("stop")));
        }
        let config = self.audio_engine_config();
        let result = self.engine.apply_audio_config(&config);
        if let Some(rate) = self.cfg("audioSampleRate").cloned()
            && jsv::truthy(&rate)
        {
            self.afm.set_pcm_sample_rate(&rate);
        }
        result
    }

    fn schedule_persist_workspace(&mut self) {
        if let Some(id) = self.save_debounce_timer.take() {
            self.clock.clear(id);
        }
        self.save_debounce_timer = Some(
            self.clock
                .set_timeout(TimerKind::SaveDebounce, self.save_debounce_ms),
        );
    }

    fn on_save_debounce(&mut self) {
        self.save_debounce_timer = None;
        let _ = self.save_workspace();
    }

    pub fn flush_persist_workspace(&mut self) -> Value {
        if let Some(id) = self.save_debounce_timer.take() {
            self.clock.clear(id);
        }
        self.save_workspace()
    }

    // --- Cues -----------------------------------------------------------------------------

    pub fn get_cues(&self) -> Vec<Value> {
        self.cdm
            .get_cues()
            .into_iter()
            .map(|c| self.merge_live_state(c))
            .collect()
    }

    pub fn get_cue(&self, cue_id: &str) -> Option<Value> {
        self.cdm
            .get_cue(&json!(cue_id))
            .cloned()
            .map(|c| self.merge_live_state(c))
    }

    fn raw_cue(&self, cue_id: &str) -> Option<&Value> {
        self.cdm.get_cue(&json!(cue_id))
    }

    fn merge_live_state(&self, cue: Value) -> Value {
        let id = jsv::to_js_string(cue.get("id").unwrap_or(&Value::Null));
        let Some(live) = self.cue_states.get(&id) else {
            return cue;
        };
        let mut out = obj(cue.clone());
        out.insert(
            "status".into(),
            live.get("status").cloned().unwrap_or_else(js::undefined),
        );
        out.insert(
            "currentTime".into(),
            nullish(
                live.get("currentTime"),
                get(&cue, "currentTime")
                    .cloned()
                    .unwrap_or_else(js::undefined),
            ),
        );
        out.insert(
            "totalTime".into(),
            nullish(
                live.get("totalTime"),
                get(&cue, "totalTime")
                    .cloned()
                    .unwrap_or_else(js::undefined),
            ),
        );
        Value::Object(out)
    }

    fn broadcast_cues(&mut self) {
        let cues = self.get_cues();
        self.ws.broadcast_cues_update(cues);
    }

    pub fn create_cue(&mut self, cue_data: &Value) -> Value {
        let r = self.create_cue_inner(cue_data);
        self.run_deferred();
        r.unwrap_or_else(|e| json!({ "success": false, "error": e }))
    }

    fn create_cue_inner(&mut self, cue_data: &Value) -> Result<Value, String> {
        if get(cue_data, "type").and_then(Value::as_str) == Some("spotify") {
            return Ok(spotify_removed());
        }
        if cue_data.is_null() || js::is_undefined(cue_data) {
            let what = if cue_data.is_null() {
                "null"
            } else {
                "undefined"
            };
            return Err(format!("Cannot read properties of {what} (reading 'type')"));
        }
        let mut data = cue_data.clone();
        let kind = get(&data, "type")
            .and_then(Value::as_str)
            .map(str::to_string);
        if kind.as_deref() == Some("single_file") && jsv::truthy_opt(get(&data, "audioFileId")) {
            let id = get(&data, "audioFileId").cloned().unwrap_or(Value::Null);
            if let Some(af) = self.afm.load_audio_file_metadata(&id)
                && jsv::truthy_opt(af.get("duration"))
                && let Some(o) = data.as_object_mut()
            {
                o.insert("knownDuration".into(), af["duration"].clone());
            }
        }
        if kind.as_deref() == Some("playlist") && jsv::truthy_opt(get(&data, "playlistItems")) {
            match data.get("playlistItems").cloned() {
                Some(Value::Array(items)) => {
                    let mut out = Vec::with_capacity(items.len());
                    for mut item in items {
                        if item.is_null() || js::is_undefined(&item) {
                            let what = if item.is_null() { "null" } else { "undefined" };
                            return Err(format!(
                                "Cannot read properties of {what} (reading 'audioFileId')"
                            ));
                        }
                        if jsv::truthy_opt(get(&item, "audioFileId")) {
                            let id = get(&item, "audioFileId").cloned().unwrap_or(Value::Null);
                            if let Some(af) = self.afm.load_audio_file_metadata(&id)
                                && jsv::truthy_opt(af.get("duration"))
                                && let Some(o) = item.as_object_mut()
                            {
                                o.insert("knownDuration".into(), af["duration"].clone());
                            }
                        }
                        out.push(item);
                    }
                    if let Some(o) = data.as_object_mut() {
                        o.insert("playlistItems".into(), Value::Array(out));
                    }
                }
                Some(Value::String(_)) => {}
                _ => return Err("cueData.playlistItems is not iterable".into()),
            }
        }
        let cue = self.cdm.create_cue(&data)?;
        let cue = self.cdm.add_cue(cue);
        self.broadcast_cues();
        self.schedule_persist_workspace();
        Ok(json!({ "success": true, "cue": cue }))
    }

    pub fn update_cue(&mut self, cue_id: &str, updates: &Value) -> Value {
        let r = self.update_cue_now(cue_id, updates);
        self.run_deferred();
        r
    }

    fn update_cue_now(&mut self, cue_id: &str, updates: &Value) -> Value {
        if get(updates, "type").and_then(Value::as_str) == Some("spotify") {
            return spotify_removed();
        }
        let result = match self.cdm.update_cue(&json!(cue_id), updates) {
            Ok(r) => r,
            Err(e) => return json!({ "success": false, "error": e }),
        };
        if success(&result) {
            let u = if jsv::truthy(updates) {
                updates.clone()
            } else {
                json!({})
            };
            self.apply_live_updates(cue_id, &u);
            self.ws.broadcast_cue_update(cue_id, updates);
            self.broadcast_cues();
            self.schedule_persist_workspace();
        }
        result
    }

    fn apply_live_updates(&mut self, cue_id: &str, updates: &Value) {
        let has = |k: &str| updates.as_object().is_some_and(|o| o.contains_key(k));
        if let Some(v @ Value::Number(_)) = updates.get("volume")
            && self.engine.is_playing(cue_id)
        {
            let v = v.clone();
            self.engine.set_cue_volume(cue_id, &v);
        }
        if has("playlistItems") {
            self.shuffle_orders.shift_remove(cue_id);
        }
        if [
            "playlistItems",
            "shufflePlaylist",
            "loop",
            "playlistPlayMode",
            "repeatOnePlaylistItem",
        ]
        .iter()
        .any(|k| has(k))
            && self.engine.is_playing(cue_id)
        {
            self.queue_next_item(cue_id);
        }
        if ["isDuckingTrigger", "enableDucking", "duckingLevel"]
            .iter()
            .any(|k| has(k))
        {
            self.update_ducking();
        }
    }

    /// `handleAudioFileReplaced(audioFile, previous)`.
    pub fn handle_audio_file_replaced(&mut self, audio_file: &Value, previous: &Value) -> Value {
        let af_id = audio_file.get("id").cloned();
        let af_rel = audio_file.get("relativePath").cloned();
        let duration = jsv::or(audio_file.get("duration"), json!(0));
        let prev_rel = get(previous, "relativePath").cloned();
        let mut map_ref = |id: Option<&Value>, rel: Option<&Value>| -> Option<Obj> {
            let matches = strict_eq(id, af_id.as_ref())
                || (prev_rel.as_ref().is_some_and(jsv::truthy)
                    && strict_eq(rel, prev_rel.as_ref()));
            matches.then(|| {
                let mut o = Obj::new();
                o.insert(
                    "audioFileId".into(),
                    af_id.clone().unwrap_or_else(js::undefined),
                );
                o.insert(
                    "relativePath".into(),
                    af_rel.clone().unwrap_or_else(js::undefined),
                );
                o.insert("knownDuration".into(), duration.clone());
                o
            })
        };
        let result = self.cdm.rewrite_audio_references(&mut map_ref);
        self.engine
            .forget_buffer(get(previous, "path").unwrap_or(&Value::Null));
        self.engine
            .forget_buffer(get(audio_file, "path").unwrap_or(&Value::Null));
        if number(result.get("cuesUpdated")) > 0.0 {
            self.schedule_persist_workspace();
        }
        self.broadcast_cues();
        self.run_deferred();
        result
    }

    pub fn reorder_cues(&mut self, order: &Value) -> Value {
        let Some(items) = order.as_array() else {
            return json!({ "success": false, "error": "cueIds must be an array" });
        };
        let ids: Vec<Value> = items
            .iter()
            .map(|e| match e {
                Value::String(_) => e.clone(),
                Value::Object(o) if !js::is_undefined(e) => {
                    o.get("id").cloned().unwrap_or_else(js::undefined)
                }
                _ => js::undefined(),
            })
            .collect();
        let result = self.cdm.reorder_cues(&Value::Array(ids));
        if success(&result) {
            self.broadcast_cues();
            self.schedule_persist_workspace();
        }
        result
    }

    pub fn delete_cue(&mut self, cue_id: &str) -> Value {
        let _ = self.stop_cue_now(cue_id, false);
        let result = self.cdm.delete_cue(&json!(cue_id));
        if success(&result) {
            self.playing_cues.shift_remove(cue_id);
            self.cue_states.shift_remove(cue_id);
            self.shuffle_orders.shift_remove(cue_id);
            self.duck_state.shift_remove(cue_id);
            self.update_ducking();
            self.broadcast_cues();
            self.schedule_persist_workspace();
        }
        self.run_deferred();
        result
    }

    // --- Triggering -----------------------------------------------------------------------

    fn status_of(&self, cue_id: &str) -> Option<String> {
        self.cue_states
            .get(cue_id)
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The one entry point for "the operator pressed this cue".
    pub fn trigger_cue(&mut self, cue_id: &str, options: &Value) -> Value {
        let r = self.trigger_cue_now(cue_id, options);
        self.run_deferred();
        r
    }

    pub fn toggle_cue(&mut self, cue_id: &str, options: &Value) -> Value {
        self.trigger_cue(cue_id, options)
    }

    fn trigger_cue_now(&mut self, cue_id: &str, options: &Value) -> Value {
        let Some(cue) = self.get_cue(cue_id) else {
            return json!({ "success": false, "error": "Cue not found" });
        };
        let status = self.status_of(cue_id);
        if let Some(status @ ("playing" | "paused")) = status.as_deref() {
            let behavior = jsv::or(
                get(options, "retriggerBehavior"),
                jsv::or(get(&cue, "retriggerBehavior"), json!("restart")),
            );
            let action = retrigger_logic::resolve_retrigger(
                behavior,
                status.to_string(),
                Some(is_playlist(&cue)),
            )
            .unwrap_or_default();
            return self.apply_retrigger_action(&cue, &action, options);
        }
        self.start_cue(cue, options)
    }

    fn with(options: &Value, key: &str, value: Value) -> Value {
        let mut o = options.as_object().cloned().unwrap_or_default();
        o.insert(key.into(), value);
        Value::Object(o)
    }

    fn cue_id_of(cue: &Value) -> String {
        jsv::to_js_string(cue.get("id").unwrap_or(&Value::Null))
    }

    fn apply_retrigger_action(&mut self, cue: &Value, action: &str, options: &Value) -> Value {
        let id = Self::cue_id_of(cue);
        match action {
            "restart" => {
                self.stop_cue_playback(&id, &json!(0));
                let Some(c) = self.get_cue(&id) else {
                    return json!({ "success": false, "error": "Cannot read properties of undefined (reading 'type')" });
                };
                self.start_cue(c, &Self::with(options, "noCrossfade", json!(true)))
            }
            "pause" => self.pause_cue(&id),
            "resume" => self.resume_cue(&id),
            "stop" => self.stop_cue_playback(&id, &json!(0)),
            "fade_stop" => {
                let ms = self.fade_out_ms_for(cue);
                self.stop_cue_playback(&id, &num(ms))
            }
            "nothing" => json!({ "success": true, "message": "Cue already playing" }),
            "new_instance" => self.start_new_instance(cue, options),
            "next_item" => self.skip_to_next_item(cue),
            other => {
                json!({ "success": false, "error": format!("Unknown retrigger action: {other}") })
            }
        }
    }

    fn fade_out_ms_for(&self, cue: &Value) -> f64 {
        let n = number(get(cue, "fadeOutTime"));
        js_max(0.0, if n.is_nan() || n == 0.0 { 0.0 } else { n })
    }

    fn start_cue(&mut self, mut cue: Value, options: &Value) -> Value {
        let id = Self::cue_id_of(&cue);
        if is_playlist(&cue) && items_len(&cue) > 0 {
            cue = self.prepare_playlist_for_start(cue);
        }
        let mut fade_in_override = Value::Null;
        if self.crossfade_mode && !jsv::truthy_opt(get(options, "noCrossfade")) {
            let crossfade_ms = nullish(self.cfg("crossfadeTime"), json!(2000));
            let others: Vec<String> = self
                .active_cue_ids()
                .into_iter()
                .filter(|o| *o != id)
                .collect();
            for other in others {
                self.stop_cue_playback(&other, &crossfade_ms);
            }
            fade_in_override = crossfade_ms;
        }
        let playback = self.start_cue_playback(
            &cue,
            &Self::with(options, "fadeInOverrideMs", fade_in_override),
        );
        if success(&playback) {
            let total = num_or0(get(&cue, "totalTime"));
            self.playing_cues.insert(id.clone(), obj(playback.clone()));
            let mut state = Obj::new();
            state.insert("status".into(), json!("playing"));
            state.insert("startTime".into(), num(self.now()));
            state.insert("currentTime".into(), json!(0));
            state.insert("totalTime".into(), total.clone());
            self.cue_states.insert(id.clone(), state);
            let mut extra = Obj::new();
            extra.insert("currentTime".into(), json!(0));
            extra.insert("totalTime".into(), total);
            for (k, v) in self.playlist_position(&cue) {
                extra.insert(k, v);
            }
            self.ws.broadcast_cue_status(&id, "playing", Some(extra));
            self.update_ducking();
        }
        playback
    }

    fn prepare_playlist_for_start(&mut self, cue: Value) -> Value {
        let id = Self::cue_id_of(&cue);
        let item_count = items_len(&cue) as f64;
        if !jsv::truthy_opt(get(&cue, "shufflePlaylist")) {
            self.shuffle_orders.shift_remove(&id);
            return cue;
        }
        let stored = self.shuffle_orders.get(&id).cloned().unwrap_or(Value::Null);
        if playlist_logic::is_valid_order(stored, item_count).unwrap_or(false) {
            return cue;
        }
        let rng = &mut self.rng;
        let order = match playlist_logic::shuffled_order_with(item_count, &mut || rng()) {
            Ok(o) => o,
            Err(_) => return cue,
        };
        let first = order.first().copied().flatten();
        self.shuffle_orders.insert(id.clone(), order_value(&order));
        let is_cued = self.status_of(&id).as_deref() == Some("cued_next");
        let current = num_or0(get(&cue, "currentPlaylistIndex"));
        if !is_cued && !strict_eq(Some(&opt_num(first)), Some(&current)) {
            let mut u = Obj::new();
            u.insert("currentPlaylistIndex".into(), opt_num(first));
            self.update_cue_now(&id, &Value::Object(u));
            return self.get_cue(&id).unwrap_or(cue);
        }
        cue
    }

    fn playlist_position(&self, cue: &Value) -> Obj {
        let mut o = Obj::new();
        if !is_playlist(cue) || items_len(cue) == 0 {
            return o;
        }
        let id = Self::cue_id_of(cue);
        let current = num_or0(get(cue, "currentPlaylistIndex"));
        let next = playlist_logic::peek_next_index(
            items_len(cue) as f64,
            number(Some(&current)),
            jsv::truthy_opt(get(cue, "shufflePlaylist")),
            self.shuffle_orders.get(&id).cloned().unwrap_or(Value::Null),
            jsv::truthy_opt(get(cue, "loop")),
        )
        .unwrap_or(Value::Null);
        o.insert("playlistIndex".into(), current);
        o.insert("nextPlaylistIndex".into(), next);
        o
    }

    fn start_new_instance(&mut self, cue: &Value, options: &Value) -> Value {
        let id = Self::cue_id_of(cue);
        let result = self.start_cue_playback(cue, &Self::with(options, "newInstance", json!(true)));
        if success(&result) {
            let count = self.engine.voice_count(&id);
            let mut extra = Obj::new();
            extra.insert("voiceCount".into(), json!(count));
            for (k, v) in self.playlist_position(cue) {
                extra.insert(k, v);
            }
            self.ws.broadcast_cue_status(&id, "playing", Some(extra));
        }
        result
    }

    fn decide(&mut self, cue: &Value, mode: &str, repeat_one: bool) -> Result<Decision, String> {
        let id = Self::cue_id_of(cue);
        let order = order_vec(self.shuffle_orders.get(&id));
        let rng = &mut self.rng;
        let d = playlist_logic::decide_item_end_with(
            items_len(cue) as f64,
            number(Some(&num_or0(get(cue, "currentPlaylistIndex")))),
            mode,
            repeat_one,
            jsv::truthy_opt(get(cue, "loop")),
            jsv::truthy_opt(get(cue, "shufflePlaylist")),
            order,
            &mut || rng(),
        )?;
        Ok(Decision {
            action: d.action,
            next_index: d.next_index,
            order: d.order.as_deref().map(order_value),
        })
    }

    fn skip_to_next_item(&mut self, cue: &Value) -> Value {
        let id = Self::cue_id_of(cue);
        let decision = match self.decide(cue, "continue", false) {
            Ok(d) => d,
            Err(e) => return json!({ "success": false, "error": e }),
        };
        self.stop_cue_playback(&id, &json!(0));
        self.remember_order(&id, decision.order.clone());
        self.set_playlist_index(cue, decision.next_index);
        if decision.action == "finish" {
            return json!({ "success": true, "finished": true });
        }
        match self.get_cue(&id) {
            Some(c) => self.start_cue(c, &json!({ "noCrossfade": true })),
            None => {
                json!({ "success": false, "error": "Cannot read properties of undefined (reading 'type')" })
            }
        }
    }

    fn remember_order(&mut self, cue_id: &str, order: Option<Value>) {
        match order {
            Some(o) => {
                self.shuffle_orders.insert(cue_id.to_string(), o);
            }
            None => {
                self.shuffle_orders.shift_remove(cue_id);
            }
        }
    }

    fn set_playlist_index(&mut self, cue: &Value, index: Option<f64>) {
        let current = num_or0(get(cue, "currentPlaylistIndex"));
        let index = opt_num(index);
        if !strict_eq(Some(&current), Some(&index)) {
            let id = Self::cue_id_of(cue);
            let mut u = Obj::new();
            u.insert("currentPlaylistIndex".into(), index);
            self.update_cue_now(&id, &Value::Object(u));
        }
    }

    // --- Stopping -------------------------------------------------------------------------

    pub fn stop_cue(&mut self, cue_id: &str, fade_out: bool) -> Value {
        let r = self.stop_cue_now(cue_id, fade_out);
        self.run_deferred();
        r
    }

    fn stop_cue_now(&mut self, cue_id: &str, fade_out: bool) -> Value {
        let Some(cue) = self.get_cue(cue_id) else {
            return json!({ "success": false, "error": "Cue not found" });
        };
        let ms = if fade_out {
            self.fade_out_ms_for(&cue)
        } else {
            0.0
        };
        self.stop_cue_playback(cue_id, &num(ms))
    }

    /// `stopAllCues(behavior)`.
    pub fn stop_all_cues(&mut self, behavior: Option<&Value>) -> Value {
        let effective = jsv::or(
            behavior,
            jsv::or(self.cfg("defaultStopAllBehavior"), json!("stop")),
        );
        let fade_out = effective.as_str() == Some("fade_out_and_stop");
        let fade_ms = nullish(self.cfg("defaultStopAllFadeOutTime"), json!(1500));
        let seconds = fade_out.then(|| js_max(0.0, number(Some(&fade_ms))) / 1000.0);
        let result = self.engine.stop_all_cues(fade_out, seconds);
        if success(&result) {
            let results = result
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for r in &results {
                if jsv::truthy_opt(r.get("fading")) {
                    continue;
                }
                let id = jsv::to_js_string(r.get("cueId").unwrap_or(&Value::Null));
                self.playing_cues.shift_remove(&id);
                self.cue_states.shift_remove(&id);
                self.ws.broadcast_cue_status(&id, "stopped", None);
            }
            let cued: Vec<String> = self
                .cue_states
                .iter()
                .filter(|(_, s)| s.get("status").and_then(Value::as_str) == Some("cued_next"))
                .map(|(k, _)| k.clone())
                .collect();
            for id in cued {
                self.cue_states.shift_remove(&id);
                self.ws.broadcast_cue_status(&id, "stopped", None);
            }
            if !fade_out {
                self.playing_cues.clear();
                self.cue_states.clear();
            }
            self.update_ducking();
        }
        result
    }

    /// `stopAllCues` as an operation of its own (runs what it deferred).
    pub fn stop_all(&mut self, behavior: Option<&Value>) -> Value {
        let r = self.stop_all_cues(behavior);
        self.run_deferred();
        r
    }

    fn stop_cue_playback(&mut self, cue_id: &str, fade_out_ms: &Value) -> Value {
        self.queued_next.shift_remove(cue_id);
        let n = number(Some(fade_out_ms));
        let fade_ms = js_max(0.0, if n.is_nan() || n == 0.0 { 0.0 } else { n });
        let result = self
            .engine
            .stop_cue(cue_id, fade_ms > 0.0, fade_ms / 1000.0);
        let is_fading = jsv::truthy_opt(result.get("fading"));
        if success(&result) && !is_fading {
            let had_state =
                self.playing_cues.contains_key(cue_id) || self.cue_states.contains_key(cue_id);
            self.playing_cues.shift_remove(cue_id);
            self.cue_states.shift_remove(cue_id);
            if had_state {
                self.ws.broadcast_cue_status(cue_id, "stopped", None);
            }
            self.update_ducking();
        }
        result
    }

    // --- Playlist navigation --------------------------------------------------------------

    pub fn navigate_playlist(&mut self, cue_id: &str, direction: &Value) -> Value {
        let r = self.navigate_playlist_now(cue_id, direction);
        self.run_deferred();
        r
    }

    fn navigate_playlist_now(&mut self, cue_id: &str, direction: &Value) -> Value {
        let cue = match self.get_cue(cue_id) {
            Some(c) if is_playlist(&c) => c,
            _ => return json!({ "success": false, "error": "Cue not found or not a playlist" }),
        };
        let current = num_or0(get(&cue, "currentPlaylistIndex"));
        let new_index = playlist_logic::step_index(
            items_len(&cue) as f64,
            number(Some(&current)),
            jsv::to_js_string(direction),
            jsv::truthy_opt(get(&cue, "shufflePlaylist")),
            self.shuffle_orders
                .get(cue_id)
                .cloned()
                .unwrap_or(Value::Null),
        )
        .unwrap_or(Value::Null);
        if !strict_eq(Some(&new_index), Some(&current)) {
            let mut u = Obj::new();
            u.insert("currentPlaylistIndex".into(), new_index.clone());
            self.update_cue_now(cue_id, &Value::Object(u));
            match self.status_of(cue_id).as_deref() {
                Some("playing" | "paused") => {
                    self.stop_cue_playback(cue_id, &json!(0));
                    if let Some(c) = self.get_cue(cue_id) {
                        self.start_cue(c, &json!({ "noCrossfade": true }));
                    }
                }
                Some("cued_next") => {
                    let name =
                        at(get(&cue, "playlistItems"), &new_index).and_then(|i| get(i, "name"));
                    let mut extra = Obj::new();
                    extra.insert("nextItem".into(), jsv::or(name, Value::Null));
                    extra.insert("playlistIndex".into(), new_index.clone());
                    self.ws
                        .broadcast_cue_status(cue_id, "cued_next", Some(extra));
                }
                _ => {}
            }
        }
        let mut r = Obj::new();
        r.insert("success".into(), json!(true));
        r.insert("newIndex".into(), new_index);
        Value::Object(r)
    }

    pub fn jump_to_playlist_item(&mut self, cue_id: &str, index: &Value) -> Value {
        let r = self.jump_now(cue_id, index);
        self.run_deferred();
        r
    }

    fn jump_now(&mut self, cue_id: &str, index: &Value) -> Value {
        let cue = match self.get_cue(cue_id) {
            Some(c) if is_playlist(&c) => c,
            _ => return json!({ "success": false, "error": "Cue not found or not a playlist" }),
        };
        let target = number(Some(index));
        let count = items_len(&cue) as f64;
        if !(target.is_finite() && target.fract() == 0.0) || target < 0.0 || target >= count {
            let max = js_max(0.0, count - 1.0);
            return json!({ "success": false, "error": format!("Item index must be 0-{}", js::number_to_string(max)) });
        }
        let mut u = Obj::new();
        u.insert("currentPlaylistIndex".into(), num(target));
        self.update_cue_now(cue_id, &Value::Object(u));
        match self.status_of(cue_id).as_deref() {
            Some("playing" | "paused") => {
                self.stop_cue_playback(cue_id, &json!(0));
                if let Some(c) = self.get_cue(cue_id) {
                    self.start_cue(c, &json!({ "noCrossfade": true }));
                }
            }
            Some("cued_next") => {
                let name =
                    at(get(&cue, "playlistItems"), &num(target)).and_then(|i| get(i, "name"));
                let mut extra = Obj::new();
                extra.insert("nextItem".into(), jsv::or(name, Value::Null));
                extra.insert("playlistIndex".into(), num(target));
                self.ws
                    .broadcast_cue_status(cue_id, "cued_next", Some(extra));
            }
            _ => {}
        }
        json!({ "success": true, "newIndex": num(target) })
    }

    // --- Pause / resume -------------------------------------------------------------------

    fn pause_cue(&mut self, cue_id: &str) -> Value {
        let has_state = self.cue_states.contains_key(cue_id);
        let result = self.engine.pause_cue(cue_id);
        if !success(&result) || !has_state {
            return if success(&result) {
                json!({ "success": false, "error": "Cue not playing" })
            } else {
                result
            };
        }
        let now = self.now();
        if let Some(state) = self.cue_states.get_mut(cue_id) {
            state.insert("status".into(), json!("paused"));
            state.insert("pausedAt".into(), num(now));
        }
        self.ws.broadcast_cue_status(cue_id, "paused", None);
        self.update_ducking();
        json!({ "success": true, "status": "paused" })
    }

    fn resume_cue(&mut self, cue_id: &str) -> Value {
        let has_state = self.cue_states.contains_key(cue_id);
        let result = self.engine.resume_cue(cue_id);
        if !success(&result) || !has_state {
            return if success(&result) {
                json!({ "success": false, "error": "Cue not paused" })
            } else {
                result
            };
        }
        let now = self.now();
        if let Some(state) = self.cue_states.get_mut(cue_id) {
            state.insert("status".into(), json!("playing"));
            state.insert("resumedAt".into(), num(now));
        }
        self.ws.broadcast_cue_status(cue_id, "playing", None);
        self.update_ducking();
        json!({ "success": true, "status": "playing" })
    }

    pub fn toggle_pause_cue(&mut self, cue_id: &str) -> Value {
        let r = if self.get_cue(cue_id).is_none() {
            json!({ "success": false, "error": "Cue not found" })
        } else {
            match self.status_of(cue_id).as_deref() {
                Some("playing") => self.pause_cue(cue_id),
                Some("paused") => self.resume_cue(cue_id),
                _ => json!({ "success": false, "error": "Cue not playing" }),
            }
        };
        self.run_deferred();
        r
    }

    /// "Make this cue play" (Companion's Play Cue), whatever its retrigger behavior (WO-008).
    pub fn play_cue(&mut self, cue_id: &str, options: &Value) -> Value {
        let r = match self.status_of(cue_id).as_deref() {
            Some("playing") => json!({ "success": true, "message": "Cue already playing" }),
            Some("paused") => self.resume_cue(cue_id),
            _ => self.trigger_cue_now(cue_id, options),
        };
        self.run_deferred();
        r
    }

    // --- Ducking --------------------------------------------------------------------------

    fn duck_multiplier_for(&self, cue_id: &str) -> f64 {
        let Some(cue) = self.raw_cue(cue_id) else {
            return 1.0;
        };
        if !jsv::truthy_opt(get(cue, "enableDucking")) {
            return 1.0;
        }
        let mut strongest: Option<f64> = None;
        for (other_id, state) in &self.cue_states {
            if other_id == cue_id || state.get("status").and_then(Value::as_str) != Some("playing")
            {
                continue;
            }
            if !self.engine.is_playing(other_id) {
                continue;
            }
            let Some(other) = self.raw_cue(other_id) else {
                continue;
            };
            if !jsv::truthy_opt(get(other, "isDuckingTrigger")) {
                continue;
            }
            let level = js_min(
                100.0,
                js_max(
                    0.0,
                    number(Some(&nullish(get(other, "duckingLevel"), json!(80)))),
                ),
            );
            strongest = Some(match strongest {
                None => level,
                Some(s) => js_max(s, level),
            });
        }
        match strongest {
            None => 1.0,
            Some(s) => 1.0 - s / 100.0,
        }
    }

    fn update_ducking(&mut self) {
        let playing = self.active_cue_ids();
        let stale: Vec<String> = self
            .duck_state
            .keys()
            .filter(|k| !playing.contains(k))
            .cloned()
            .collect();
        for k in stale {
            self.duck_state.shift_remove(&k);
        }
        for cue_id in playing {
            let target = self.duck_multiplier_for(&cue_id);
            let current = self.duck_state.get(&cue_id).copied().unwrap_or(1.0);
            if (target - current).abs() > 1e-9 {
                let secs = self.duck_fade_seconds();
                self.engine.set_cue_duck(&cue_id, target, secs);
                self.duck_state.insert(cue_id, target);
            }
        }
    }

    fn duck_fade_seconds(&self) -> f64 {
        let ms = nullish(self.cfg("duckingFadeTime"), num(DEFAULT_DUCK_FADE_MS));
        js_max(0.0, number(Some(&ms))) / 1000.0
    }

    // --- Crossfade mode -------------------------------------------------------------------

    pub fn set_crossfade_mode(&mut self, enabled: &Value) -> Value {
        self.crossfade_mode = jsv::truthy(enabled);
        self.ws.broadcast(json!({
            "type": "crossfade-mode-updated",
            "payload": { "enabled": self.crossfade_mode },
        }));
        json!({ "success": true, "enabled": self.crossfade_mode })
    }

    pub fn get_crossfade_mode(&self) -> bool {
        self.crossfade_mode
    }

    fn start_cue_playback(&mut self, cue: &Value, options: &Value) -> Value {
        let id = Self::cue_id_of(cue);
        let mut file_path: Option<Value> = None;
        let mut audio_file: Option<Obj> = None;
        let kind = get(cue, "type").and_then(Value::as_str);
        if kind == Some("single_file") && jsv::truthy_opt(get(cue, "relativePath")) {
            let rel = jsv::to_js_string(&cue["relativePath"]);
            audio_file = self.afm.get_audio_file_by_path(&rel);
            if let Some(af) = &audio_file {
                file_path = Some(af.get("path").cloned().unwrap_or_else(js::undefined));
            }
        }
        let index = num_or0(get(cue, "currentPlaylistIndex"));
        if kind == Some("playlist")
            && items_len(cue) > 0
            && let Some(item) = at(get(cue, "playlistItems"), &index).filter(|i| jsv::truthy(i))
        {
            let rel = jsv::to_js_string(get(item, "relativePath").unwrap_or(&js::undefined()));
            audio_file = self.afm.get_audio_file_by_path(&rel);
            if let Some(af) = &audio_file {
                file_path = Some(af.get("path").cloned().unwrap_or_else(js::undefined));
            }
        }
        let Some(file_path) = file_path.filter(jsv::truthy) else {
            return json!({ "success": false, "error": "Audio file not found" });
        };
        let volume = match get(cue, "volume") {
            Some(v @ Value::Number(_)) => v.clone(),
            _ => json!(1.0),
        };
        let fade_in_ms = nullish(
            get(options, "fadeInOverrideMs"),
            nullish(get(cue, "fadeInTime"), json!(0)),
        );
        let empty = json!({});
        let trim_source = if kind == Some("playlist") {
            at(get(cue, "playlistItems"), &index)
                .filter(|i| jsv::truthy(i))
                .unwrap_or(&empty)
        } else {
            cue
        };
        let duck_gain = self.duck_multiplier_for(&id);
        let mut po = Obj::new();
        po.insert("volume".into(), volume.clone());
        po.insert(
            "fadeInTime".into(),
            num(js_max(0.0, number(Some(&fade_in_ms))) / 1000.0),
        );
        po.insert(
            "fadeOutTime".into(),
            num(number(Some(&num_or0(get(cue, "fadeOutTime")))) / 1000.0),
        );
        po.insert(
            "trimStartTime".into(),
            num_or0(get(trim_source, "trimStartTime")),
        );
        po.insert(
            "trimEndTime".into(),
            jsv::or(get(trim_source, "trimEndTime"), Value::Null),
        );
        po.insert(
            "loop".into(),
            json!(if kind == Some("playlist") {
                false
            } else {
                jsv::truthy_opt(get(cue, "loop"))
            }),
        );
        po.insert(
            "outputPatch".into(),
            get(cue, "outputPatch")
                .cloned()
                .unwrap_or_else(js::undefined),
        );
        po.insert("duckGain".into(), num(duck_gain));
        po.insert(
            "newInstance".into(),
            json!(jsv::truthy_opt(get(options, "newInstance"))),
        );
        let result = self.engine.play_cue(&id, &file_path, &Value::Object(po));
        if !success(&result) {
            return result;
        }
        self.duck_state.insert(id.clone(), duck_gain);
        let af = audio_file.unwrap_or_default();
        let mut info = Obj::new();
        info.insert("cueId".into(), json!(id));
        info.insert("startTime".into(), num(self.now()));
        info.insert("duration".into(), jsv::or(af.get("duration"), json!(0)));
        info.insert("volume".into(), volume);
        info.insert("fadeInTime".into(), fade_in_ms);
        info.insert("fadeOutTime".into(), num_or0(get(cue, "fadeOutTime")));
        info.insert(
            "source".into(),
            jsv::or(get(options, "source"), json!("unknown")),
        );
        info.insert(
            "audioFileId".into(),
            af.get("id").cloned().unwrap_or_else(js::undefined),
        );
        info.insert("filePath".into(), file_path);
        if kind == Some("playlist") {
            self.queue_next_item(&id);
        }
        json!({ "success": true, "playbackInfo": info })
    }

    // --- Playback end, playlists ----------------------------------------------------------

    fn handle_cue_playback_complete(&mut self, cue_id: &str, reason: &str) {
        let Some(cue) = self.get_cue(cue_id) else {
            return;
        };
        self.playing_cues.shift_remove(cue_id);
        if reason == "completed" && is_playlist(&cue) && items_len(&cue) > 0 {
            self.handle_playlist_item_end(&cue);
            return;
        }
        let total = num_or0(get(&cue, "totalTime"));
        let mut state = Obj::new();
        state.insert("status".into(), json!(reason));
        state.insert("currentTime".into(), total.clone());
        state.insert("totalTime".into(), total);
        state.insert("completedAt".into(), num(self.now()));
        self.cue_states.insert(cue_id.to_string(), state);
        self.ws.broadcast_cue_status(cue_id, reason, None);
        self.update_ducking();
    }

    fn item_end_decision(&mut self, cue: &Value) -> Result<Decision, String> {
        let mode = jsv::to_js_string(&jsv::or(get(cue, "playlistPlayMode"), json!("continue")));
        let repeat_one = jsv::truthy_opt(get(cue, "repeatOnePlaylistItem"));
        self.decide(cue, &mode, repeat_one)
    }

    /// Gapless playlists (WO-006): queue the item that will follow the playing one.
    fn queue_next_item(&mut self, cue_id: &str) {
        self.queue_token += 1.0;
        let token = self.queue_token;
        self.queued_next.shift_remove(cue_id);
        self.engine.clear_next(cue_id);
        let Some(cue) = self.get_cue(cue_id) else {
            return;
        };
        if !is_playlist(&cue) || items_len(&cue) == 0 || !self.engine.is_playing(cue_id) {
            return;
        }
        let from_index = num_or0(get(&cue, "currentPlaylistIndex"));
        let Ok(decision) = self.item_end_decision(&cue) else {
            return;
        };
        if decision.action != "play" {
            return;
        }
        let item = decision
            .next_index
            .and_then(|i| at(get(&cue, "playlistItems"), &num(i)))
            .cloned()
            .unwrap_or_else(js::undefined);
        if !jsv::truthy(&item) {
            return;
        }
        self.deferred.push_back(Deferred::QueueNext {
            cue_id: cue_id.to_string(),
            token,
            decision,
            item,
            from_index,
        });
    }

    fn queue_next_rest(
        &mut self,
        cue_id: String,
        token: f64,
        decision: Decision,
        item: Value,
        from_index: Value,
    ) {
        let rel = jsv::to_js_string(get(&item, "relativePath").unwrap_or(&js::undefined()));
        let Some(af) = self.afm.get_audio_file_by_path(&rel) else {
            return;
        };
        self.queued_next
            .insert(cue_id.clone(), Queued { token, decision });
        let path = af.get("path").cloned().unwrap_or_else(js::undefined);
        let mut opts = Obj::new();
        opts.insert("trimStartTime".into(), num_or0(get(&item, "trimStartTime")));
        opts.insert(
            "trimEndTime".into(),
            jsv::or(get(&item, "trimEndTime"), Value::Null),
        );
        opts.insert("token".into(), num(token));
        let queued_map = &self.queued_next;
        let cdm = &self.cdm;
        let id_value = json!(cue_id);
        let mut still_wanted = || {
            queued_map.get(&cue_id).is_some_and(|q| q.token == token)
                && strict_eq(
                    Some(&num_or0(
                        cdm.get_cue(&id_value)
                            .and_then(|c| get(c, "currentPlaylistIndex")),
                    )),
                    Some(&from_index),
                )
        };
        let queued =
            self.engine
                .queue_next(&cue_id, &path, &Value::Object(opts), &mut still_wanted);
        if !queued
            && self
                .queued_next
                .get(&cue_id)
                .is_some_and(|q| q.token == token)
        {
            self.queued_next.shift_remove(&cue_id);
        }
    }

    /// Runs the parts of operations the original runs after the operation itself (see the top).
    pub fn run_deferred(&mut self) {
        while let Some(d) = self.deferred.pop_front() {
            match d {
                Deferred::QueueNext {
                    cue_id,
                    token,
                    decision,
                    item,
                    from_index,
                } => {
                    self.queue_next_rest(cue_id, token, decision, item, from_index);
                }
            }
        }
    }

    fn handle_playlist_advance(&mut self, cue_id: &str, token: &Value) {
        let Some(queued) = self.queued_next.get(cue_id).cloned() else {
            return;
        };
        if !strict_eq(Some(&num(queued.token)), Some(token)) {
            return;
        }
        self.queued_next.shift_remove(cue_id);
        let decision = queued.decision;
        self.remember_order(cue_id, decision.order.clone());
        let Some(cue) = self.get_cue(cue_id) else {
            return;
        };
        self.set_playlist_index(&cue, decision.next_index);
        let Some(cue) = self.get_cue(cue_id) else {
            return;
        };
        let start = self.now();
        let total = num_or0(get(&cue, "totalTime"));
        let mut state = Obj::new();
        state.insert("status".into(), json!("playing"));
        state.insert("startTime".into(), num(start));
        state.insert("currentTime".into(), json!(0));
        state.insert("totalTime".into(), total.clone());
        self.cue_states.insert(cue_id.to_string(), state);
        if self.playing_cues.contains_key(cue_id) {
            let item = decision
                .next_index
                .and_then(|i| at(get(&cue, "playlistItems"), &num(i)))
                .cloned();
            let af = match item.filter(jsv::truthy) {
                Some(item) => {
                    let rel =
                        jsv::to_js_string(get(&item, "relativePath").unwrap_or(&js::undefined()));
                    self.afm.get_audio_file_by_path(&rel)
                }
                None => None,
            };
            if let Some(info) = self.playing_cues.get_mut(cue_id) {
                let af = af.unwrap_or_default();
                info.insert("startTime".into(), num(start));
                info.insert("duration".into(), jsv::or(af.get("duration"), json!(0)));
                info.insert(
                    "audioFileId".into(),
                    af.get("id").cloned().unwrap_or_else(js::undefined),
                );
                info.insert(
                    "filePath".into(),
                    af.get("path").cloned().unwrap_or_else(js::undefined),
                );
            }
        }
        let mut extra = Obj::new();
        extra.insert("currentTime".into(), json!(0));
        extra.insert("totalTime".into(), total);
        for (k, v) in self.playlist_position(&cue) {
            extra.insert(k, v);
        }
        self.ws.broadcast_cue_status(cue_id, "playing", Some(extra));
        self.queue_next_item(cue_id);
    }

    fn handle_playlist_item_end(&mut self, cue: &Value) {
        let id = Self::cue_id_of(cue);
        self.queued_next.shift_remove(&id);
        let Ok(decision) = self.item_end_decision(cue) else {
            return;
        };
        self.remember_order(&id, decision.order.clone());
        self.set_playlist_index(cue, decision.next_index);
        if decision.action == "finish" {
            self.cue_states.shift_remove(&id);
            self.ws.broadcast_cue_status(&id, "completed", None);
            self.update_ducking();
            return;
        }
        if decision.action == "cue" {
            let next = decision
                .next_index
                .and_then(|i| at(get(cue, "playlistItems"), &num(i)));
            let name = next.and_then(|n| get(n, "name")).cloned();
            let mut state = Obj::new();
            state.insert("status".into(), json!("cued_next"));
            state.insert("currentTime".into(), json!(0));
            state.insert("totalTime".into(), json!(0));
            self.cue_states.insert(id.clone(), state);
            let mut extra = Obj::new();
            extra.insert("nextItem".into(), jsv::or(name.as_ref(), Value::Null));
            extra.insert("playlistIndex".into(), opt_num(decision.next_index));
            self.ws.broadcast_cue_status(&id, "cued_next", Some(extra));
            self.update_ducking();
            return;
        }
        let Some(c) = self.get_cue(&id) else { return };
        let result = self.start_cue(
            c,
            &json!({ "source": "playlist_advance", "noCrossfade": true }),
        );
        if !success(&result) {
            self.cue_states.shift_remove(&id);
            self.ws.broadcast_cue_status(&id, "stopped", None);
            self.update_ducking();
        }
    }

    // --- Projects -------------------------------------------------------------------------

    pub fn get_current_workspace(&self) -> Value {
        self.cdm.current_workspace().unwrap_or(Value::Null)
    }

    pub fn save_workspace(&mut self) -> Value {
        self.cdm.save_workspace(None, None)
    }

    fn switch_project(
        &mut self,
        activate: impl FnOnce(&mut Self) -> Result<Value, String>,
    ) -> Result<Value, String> {
        self.flush_persist_workspace();
        self.stop_all_cues(Some(&json!("stop")));
        self.cue_states.clear();
        self.shuffle_orders.clear();
        self.playing_cues.clear();
        let result = activate(self)?;
        if success(&result) {
            let ws = self.get_current_workspace();
            self.ws.broadcast_workspace_update(ws);
            self.broadcast_cues();
        }
        Ok(result)
    }

    pub fn new_project(&mut self, name: &Value) -> Value {
        let trimmed = js_trim(&jsv::to_js_string(&jsv::or(Some(name), json!(""))));
        let project_name = if trimmed.is_empty() {
            "Untitled Project".to_string()
        } else {
            trimmed
        };
        let r = self.switch_project(|cm| {
            let ws = cm
                .cdm
                .create_workspace(Some(&json!(project_name)), None, &json!({}))
                .map_err(|e| e.to_string())?;
            Ok(json!({ "success": true, "workspace": ws }))
        });
        self.run_deferred();
        r.unwrap_or_else(|e| json!({ "$error": e }))
    }

    pub fn open_project(&mut self, project_id: &Value) -> Value {
        let id = project_id.clone();
        let r = self.switch_project(|cm| Ok(cm.cdm.load_workspace(&id)));
        self.run_deferred();
        r.unwrap_or_else(|e| json!({ "$error": e }))
    }

    pub fn rename_project(&mut self, name: &Value) -> Value {
        let raw = nullish(Some(name), json!(""));
        let project_name = js_trim(&jsv::to_js_string(&raw));
        if project_name.is_empty() {
            return json!({ "success": false, "error": "Project name cannot be empty" });
        }
        if self.cdm.current_workspace().is_none() {
            return json!({ "success": false, "error": "No project is open" });
        }
        self.cdm.set_current_name(slice_units(&project_name, 200));
        let saved = self.flush_persist_workspace();
        let ws = self.get_current_workspace();
        self.ws.broadcast_workspace_update(ws);
        if success(&saved) {
            json!({ "success": true, "project": Self::project_summary(&self.get_current_workspace()) })
        } else {
            saved
        }
    }

    pub fn delete_project(&mut self, project_id: &Value) -> Value {
        if strict_eq(Some(project_id), self.cdm.current_id().as_ref()) {
            return json!({ "success": false, "error": "The open project cannot be deleted - open another one first" });
        }
        self.cdm.delete_workspace(project_id)
    }

    fn project_summary(ws: &Value) -> Value {
        let cue_count = match get(ws, "cues") {
            Some(Value::Array(a)) => json!(a.len()),
            _ => nullish(get(ws, "cueCount"), json!(0)),
        };
        let mut o = Obj::new();
        o.insert(
            "id".into(),
            get(ws, "id").cloned().unwrap_or_else(js::undefined),
        );
        o.insert(
            "name".into(),
            get(ws, "name").cloned().unwrap_or_else(js::undefined),
        );
        o.insert("cueCount".into(), cue_count);
        o.insert(
            "createdAt".into(),
            get(ws, "createdAt").cloned().unwrap_or_else(js::undefined),
        );
        o.insert(
            "updatedAt".into(),
            jsv::or(
                get(ws, "updatedAt"),
                get(ws, "lastModified")
                    .cloned()
                    .unwrap_or_else(js::undefined),
            ),
        );
        Value::Object(o)
    }

    pub fn list_projects(&mut self) -> Value {
        self.flush_persist_workspace();
        let current = self.cdm.current_id();
        let workspaces = self.cdm.get_all_workspaces(false);
        Value::Array(
            workspaces
                .iter()
                .map(|w| {
                    let mut o = obj(Self::project_summary(w));
                    o.insert(
                        "isCurrent".into(),
                        json!(strict_eq(w.get("id"), current.as_ref())),
                    );
                    Value::Object(o)
                })
                .collect(),
        )
    }

    pub fn get_current_project(&self) -> Value {
        match self.cdm.current_workspace() {
            Some(ws) => {
                let mut o = obj(ws);
                o.insert("cues".into(), Value::Array(self.cdm.get_cues()));
                Self::project_summary(&Value::Object(o))
            }
            None => Value::Null,
        }
    }

    /// `importProject({ project, audio })`: `audio` is `(path, name)` of each unpacked file.
    pub fn import_project(&mut self, project: &Value, audio: &[(String, String)]) -> Value {
        let mut by_name: IndexMap<String, Obj> = IndexMap::new();
        let (mut added, mut reused, mut renamed) = (0, 0, 0);
        let mut failed = Vec::new();
        for (path, name) in audio {
            let r = self.afm.add_file(path, Some(name), &json!({}));
            if !success(&r) {
                failed.push(json!({ "name": name, "error": r.get("error").cloned().unwrap_or_else(js::undefined) }));
                continue;
            }
            by_name.insert(
                jsv::lower(name),
                obj(r.get("audioFile").cloned().unwrap_or(Value::Null)),
            );
            if jsv::truthy_opt(r.get("reused")) {
                reused += 1;
            } else {
                added += 1;
            }
            if jsv::truthy_opt(r.get("renamed")) {
                renamed += 1;
            }
        }
        let mut cues = nullish(get(project, "cues"), json!([]));
        library::rewrite_cue_references(Some(&mut cues), &mut |_, rel| {
            let rel = rel.filter(|v| jsv::truthy(v))?;
            let record = by_name.get(&jsv::lower(&nfs::basename(&jsv::to_js_string(rel), None)))?;
            let mut o = Obj::new();
            o.insert(
                "audioFileId".into(),
                record.get("id").cloned().unwrap_or_else(js::undefined),
            );
            o.insert(
                "relativePath".into(),
                record
                    .get("relativePath")
                    .cloned()
                    .unwrap_or_else(js::undefined),
            );
            Some(o)
        });
        let trimmed = js_trim(&jsv::to_js_string(&jsv::or(
            get(project, "name"),
            json!(""),
        )));
        let name = if trimmed.is_empty() {
            "Imported Project".to_string()
        } else {
            trimmed
        };
        let description = jsv::or(get(project, "description"), json!(""));
        let mut options = Obj::new();
        options.insert("cues".into(), cues);
        options.insert(
            "layout".into(),
            get(project, "layout")
                .cloned()
                .unwrap_or_else(js::undefined),
        );
        let options = Value::Object(options);
        let r = self.switch_project(|cm| {
            let ws = cm
                .cdm
                .create_workspace(Some(&json!(name)), Some(&description), &options)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "success": true, "workspace": ws }))
        });
        self.run_deferred();
        match r {
            Ok(result) => {
                let mut o = obj(result);
                o.insert("project".into(), self.get_current_project());
                o.insert(
                    "audio".into(),
                    json!({ "added": added, "reused": reused, "renamed": renamed, "failed": failed }),
                );
                Value::Object(o)
            }
            Err(e) => json!({ "$error": e }),
        }
    }

    // --- Engine events, status, master volume, cleanup ------------------------------------

    /// Handles what the engine reported (the original's callbacks).
    pub fn pump_engine_events(&mut self) {
        loop {
            let events = self.engine.take_events();
            if events.is_empty() {
                break;
            }
            for event in events {
                match event {
                    EngineEvent::PlaybackEnd { cue_id, reason } => {
                        self.handle_cue_playback_complete(&cue_id, &reason);
                    }
                    EngineEvent::Advance { cue_id, token } => {
                        self.handle_playlist_advance(&cue_id, &token);
                    }
                    EngineEvent::Error(payload) => {
                        self.ws
                            .broadcast(json!({ "type": "audio-engine-error", "payload": payload }));
                    }
                }
                self.run_deferred();
            }
        }
    }

    /// Runs every timer due within `ms` (the fake clock's `advance`).
    pub fn advance_clock(&mut self, ms: f64) {
        let target = self.now() + ms;
        while let Some(kind) = self.clock.take_due(target) {
            self.run_timer(kind);
        }
        self.clock.set_now(target);
    }

    /// Runs every timer due now (the real clock, polled by the server).
    pub fn run_due_timers(&mut self) {
        let now = self.now();
        while let Some(kind) = self.clock.take_due(now) {
            self.run_timer(kind);
        }
    }

    fn run_timer(&mut self, kind: TimerKind) {
        match kind {
            TimerKind::SaveDebounce => self.on_save_debounce(),
            TimerKind::PlaybackTime => self.playback_time_tick(),
        }
        self.run_deferred();
    }

    pub fn get_playback_status(&self) -> Value {
        let mut status = Obj::new();
        status.insert(
            "playingCues".into(),
            Value::Array(self.playing_cues.keys().map(|k| json!(k)).collect()),
        );
        status.insert("totalPlaying".into(), json!(self.playing_cues.len()));
        let mut states = Obj::new();
        for (k, v) in &self.cue_states {
            states.insert(k.clone(), Value::Object(v.clone()));
        }
        jsv::js_order(&mut states);
        status.insert("cueStates".into(), Value::Object(states));
        status.insert("masterVolume".into(), num(self.engine.master_volume()));
        status.insert("crossfadeMode".into(), json!(self.crossfade_mode));
        status.insert(
            "engine".into(),
            json!({
                "deviceId": self.engine.device_id(),
                "sampleRate": self.engine.sample_rate(),
                "channelCount": self.engine.channel_count(),
            }),
        );
        let voices: Vec<Value> = self
            .engine
            .voices()
            .into_iter()
            .map(|v| {
                let mut o = Obj::new();
                for (to, from) in [
                    ("cueId", "cueId"),
                    ("voiceId", "voiceId"),
                    ("isPaused", "isPaused"),
                    ("isFadingIn", "isFadingIn"),
                    ("isFadingOut", "isFadingOut"),
                    ("isDucked", "isDucked"),
                    ("duckGain", "duckGain"),
                    ("gain", "currentGain"),
                    ("volume", "volume"),
                    ("positionSec", "positionSec"),
                    ("trimStartSec", "trimStartSec"),
                    ("trimEndSec", "trimEndSec"),
                    ("outputPatch", "outputPatch"),
                ] {
                    o.insert(
                        to.into(),
                        v.get(from).cloned().unwrap_or_else(js::undefined),
                    );
                }
                Value::Object(o)
            })
            .collect();
        status.insert("voices".into(), Value::Array(voices));
        Value::Object(status)
    }

    pub fn set_master_volume(&mut self, volume: &Value) -> Value {
        let Some(v) = volume.as_f64() else {
            return json!({ "success": false, "error": "volume must be a number" });
        };
        self.engine.set_master_volume(v);
        let applied = num(self.engine.master_volume());
        self.ws.broadcast(
            json!({ "type": "master-volume-updated", "payload": { "volume": applied } }),
        );
        json!({ "success": true, "volume": applied })
    }

    pub fn get_master_volume(&self) -> f64 {
        self.engine.master_volume()
    }

    pub fn cleanup(&mut self) {
        self.stop_all_cues(Some(&json!("stop")));
        self.engine.cleanup();
        if let Some(id) = self.playback_time_interval.take() {
            self.clock.clear(id);
        }
        self.flush_persist_workspace();
        self.run_deferred();
    }

    /// The live state the differential check compares (`rust/scripts/drive-data.js`).
    pub fn debug_state(&self) -> Value {
        let map = |m: &IndexMap<String, Value>| {
            let mut o = Obj::new();
            for (k, v) in m {
                o.insert(k.clone(), v.clone());
            }
            Value::Object(o)
        };
        let mut playing = Obj::new();
        for (k, v) in &self.playing_cues {
            playing.insert(k.clone(), Value::Object(v.clone()));
        }
        let mut queued = Obj::new();
        for (k, q) in &self.queued_next {
            queued.insert(
                k.clone(),
                json!({ "token": num(q.token), "decision": q.decision.to_value() }),
            );
        }
        let mut duck = Obj::new();
        for (k, v) in &self.duck_state {
            duck.insert(k.clone(), num(*v));
        }
        json!({
            "status": self.get_playback_status(),
            "playingCues": playing,
            "shuffleOrders": map(&self.shuffle_orders),
            "queuedNext": queued,
            "queueToken": num(self.queue_token),
            "duckState": duck,
            "crossfadeMode": self.crossfade_mode,
            "config": self.config,
            "timers": self.clock.pending().into_iter()
                .map(|(due, interval)| json!({ "due": num(due), "interval": interval.map_or(Value::Null, num) }))
                .collect::<Vec<_>>(),
            "now": num(self.now()),
        })
    }
}

/// `Math.random()` for the app (the differential check injects its own sequence).
fn rand_unit() -> f64 {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let n = u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]);
    (n >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mmss_matches_the_original() {
        assert_eq!(CueManager::format_time_mmss(0.0), "00:00");
        assert_eq!(CueManager::format_time_mmss(9.99), "00:09");
        assert_eq!(CueManager::format_time_mmss(61.5), "01:01");
        assert_eq!(CueManager::format_time_mmss(f64::NAN), "00:00");
        assert_eq!(CueManager::format_time_mmss(-3.0), "00:00");
        assert_eq!(CueManager::format_time_mmss(6000.0), "100:00");
    }

    #[test]
    fn strict_equality_is_javascripts() {
        assert!(strict_eq(Some(&json!(2)), Some(&json!(2.0))));
        assert!(strict_eq(None, Some(&js::undefined())));
        assert!(!strict_eq(Some(&json!(0)), Some(&json!("0"))));
        assert!(!strict_eq(Some(&json!(null)), None));
        assert!(!strict_eq(Some(&json!([1])), Some(&json!([1]))));
    }

    #[test]
    fn js_max_and_min_let_nan_through() {
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(100.0, f64::NAN).is_nan());
        assert_eq!(js_max(0.0, -1.0), 0.0);
    }

    #[test]
    fn numbers_print_as_json_stringify_does() {
        assert_eq!(num(f64::NAN), Value::Null);
        assert_eq!(num(3.0), json!(3));
        assert_eq!(num(0.25), json!(0.25));
    }

    #[test]
    fn slice_keeps_utf16_units() {
        assert_eq!(slice_units("abc", 2), json!("ab"));
        // Cutting an emoji in half leaves a lone surrogate, as `slice` does in JS.
        assert_eq!(slice_units("a😀", 2), js::utf16_string(&[0x61, 0xD83D]));
    }
}
