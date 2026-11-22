//! The Rust port of `src/backend/soundboardMixer.js` (through `rust/shims/soundboard-mixer/`).
//!
//! [`Mixer`] is the real-time mixer the audio engine will use; [`run_mixer`] is the deterministic
//! driver the shim exposes for recording. The port keeps the original's number semantics on
//! purpose: positions, trims, gains and ramps are f64 (JS numbers), source and output samples are
//! f32 (`Float32Array`), and every output write rounds `out + x` to f32 as `+=` on a typed array
//! does. `Math.min`/`Math.max` propagate NaN (unlike `f64::min`), so they are [`js_min`]/[`js_max`].

#![forbid(unsafe_code)]

use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::js;

/// `Math.min`: NaN if either is NaN, `-0` below `+0`.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max`: NaN if either is NaN, `+0` above `-0`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == b {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_max(min, js_min(max, value))
}

/// JS `x || fallback` for a number (`undefined`, `null`, `0`, `-0` and NaN are falsy).
fn or(x: Option<f64>, fallback: f64) -> f64 {
    match x {
        Some(v) if v != 0.0 && !v.is_nan() => v,
        _ => fallback,
    }
}

fn seconds_to_frame(time_sec: f64, sample_rate: f64) -> f64 {
    js_max(0.0, (time_sec * sample_rate).floor())
}

fn compute_gain_step(current: f64, target: f64, fade_seconds: f64, sample_rate: f64) -> f64 {
    if fade_seconds <= 0.0 || sample_rate <= 0.0 {
        return target - current;
    }
    let fade_frames = fade_seconds * sample_rate;
    if fade_frames <= 0.0 {
        return target - current;
    }
    (target - current) / fade_frames
}

/// Advances a ramp (fade or duck) by one frame.
fn step_ramp(current: f64, target: f64, step: f64) -> f64 {
    if current == target {
        return current;
    }
    let next = current + step;
    if (target - next).abs() < step.abs() {
        target
    } else {
        next
    }
}

fn ramp_remaining_sec(current: f64, target: f64, step: f64, sample_rate: f64) -> f64 {
    if step == 0.0 || current == target {
        return 0.0;
    }
    js_max(0.0, (target - current) / step) / sample_rate
}

/// A typed-array element: `None` (JS `undefined`) unless `index` is an integer inside the array.
fn element(buffer: &[f32], index: f64) -> Option<f32> {
    if index.fract() == 0.0 && index >= 0.0 && index < buffer.len() as f64 {
        Some(buffer[index as usize])
    } else {
        None
    }
}

/// `out[index] += x` on a `Float32Array`: ignored outside it, rounded to f32 inside.
fn add_to(out: &mut [f32], index: f64, x: f64) {
    if index.fract() == 0.0 && index >= 0.0 && index < out.len() as f64 {
        let i = index as usize;
        out[i] = (f64::from(out[i]) + x) as f32;
    }
}

/// `playCue`/`queueNext` options. `None` is JS `undefined`/`null`.
#[derive(Debug, Clone, Default)]
pub struct PlayOptions {
    pub channels: Option<f64>,
    pub sample_rate: Option<f64>,
    pub trim_start_time: Option<f64>,
    pub trim_end_time: Option<f64>,
    pub volume: Option<f64>,
    pub fade_in_time: Option<f64>,
    /// `None`: the default `[0, 1]`; elements are `outputPatch[i]` (`None` = missing or null).
    pub output_patch: Option<Vec<Option<f64>>>,
    pub duck_gain: Option<f64>,
    pub new_instance: bool,
    pub loop_: bool,
    /// Handed back by [`MixerEvent::Advance`] (`queueNext`).
    pub token: Option<Value>,
}

/// What a render reports, in the original's callback order: every advance, then every removal.
#[derive(Debug, Clone, PartialEq)]
pub enum MixerEvent {
    /// `onCueAdvance`: a voice went on into its queued next buffer.
    Advance {
        cue_id: Arc<str>,
        token: Option<Value>,
    },
    /// `onCueComplete`: a cue's last voice ended (`"completed"` or `"stopped"`).
    Complete {
        cue_id: Arc<str>,
        reason: &'static str,
    },
}

struct Segment {
    buffer: Arc<[f32]>,
    channels: f64,
    sample_rate: f64,
    trim_start_frame: f64,
    trim_end_frame: f64,
    token: Option<Value>,
}

struct Voice {
    cue_id: Arc<str>,
    voice_id: Arc<str>,
    buffer: Arc<[f32]>,
    channels: f64,
    sample_rate: f64,
    trim_start_frame: f64,
    trim_end_frame: f64,
    position: f64,
    loop_: bool,
    output_patch: [f64; 2],
    volume: f64,
    current_gain: f64,
    gain_target: f64,
    gain_step: f64,
    duck_gain: f64,
    duck_target: f64,
    duck_step: f64,
    stopping: bool,
    is_paused: bool,
    next: Option<Segment>,
    peak_accum: f64,
}

/// One voice in [`Mixer::status`] (`getStatus().playing[i]`).
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceStatus {
    pub cue_id: Arc<str>,
    pub voice_id: Arc<str>,
    pub is_paused: bool,
    pub stopping: bool,
    pub is_fading_out: bool,
    pub is_fading_in: bool,
    pub fade_remaining_sec: f64,
    pub is_ducked: bool,
    pub duck_gain: f64,
    pub position_sec: f64,
    pub trim_start_sec: f64,
    pub trim_end_sec: f64,
    pub volume: f64,
    pub current_gain: f64,
    pub output_patch: [f64; 2],
}

/// `getStatus()`.
#[derive(Debug, Clone, PartialEq)]
pub struct MixerStatus {
    pub sample_rate: f64,
    pub channel_count: f64,
    pub active_count: usize,
    pub master_gain: f64,
    pub playing: Vec<VoiceStatus>,
}

/// The mixer (`SoundboardMixer`). Voices keep start order; a cue may have several ("new instance").
pub struct Mixer {
    pub sample_rate: f64,
    pub channel_count: f64,
    pub master_gain: f64,
    voices: IndexMap<Arc<str>, Voice>,
    voice_counter: u64,
    events: Vec<MixerEvent>,
    removals: Vec<(usize, &'static str)>,
}

fn trims(len: usize, channels: f64, sample_rate: f64, opts: &PlayOptions) -> (f64, f64) {
    let total_frames = (len as f64 / channels).floor();
    let trim_start_time = or(opts.trim_start_time, 0.0);
    let trim_end_time = opts.trim_end_time.unwrap_or(total_frames / sample_rate);
    let start = clamp(
        seconds_to_frame(trim_start_time, sample_rate),
        0.0,
        js_max(0.0, total_frames - 1.0),
    );
    let end = clamp(
        seconds_to_frame(trim_end_time, sample_rate),
        start + 1.0,
        total_frames,
    );
    (start, end)
}

impl Mixer {
    pub fn new(sample_rate: f64, channel_count: f64) -> Self {
        Mixer {
            sample_rate,
            channel_count,
            master_gain: 1.0,
            voices: IndexMap::new(),
            voice_counter: 0,
            events: Vec::new(),
            removals: Vec::new(),
        }
    }

    /// `setMasterGain`: `clamp(Number(value) || 0, 0, 2)`.
    pub fn set_master_gain(&mut self, value: f64) {
        self.master_gain = clamp(or(Some(value), 0.0), 0.0, 2.0);
    }

    fn voices_of<'a>(&'a self, cue_id: &'a str) -> impl Iterator<Item = &'a Voice> + 'a {
        self.voices.values().filter(move |v| &*v.cue_id == cue_id)
    }

    pub fn has_cue(&self, cue_id: &str) -> bool {
        self.voices_of(cue_id).next().is_some()
    }

    pub fn voice_count(&self, cue_id: &str) -> usize {
        self.voices_of(cue_id).count()
    }

    pub fn active_count(&self) -> usize {
        self.voices.len()
    }

    /// `playCue`: replaces the cue's voices (silently) unless `new_instance`; returns the voice id.
    pub fn play_cue(&mut self, cue_id: &str, buffer: Arc<[f32]>, opts: &PlayOptions) -> Arc<str> {
        let channels = or(opts.channels, 2.0);
        let sample_rate = or(opts.sample_rate, self.sample_rate);
        let (trim_start_frame, trim_end_frame) = trims(buffer.len(), channels, sample_rate, opts);
        let volume = opts.volume.unwrap_or(1.0);
        let fade_in_time = or(opts.fade_in_time, 0.0);
        let duck_gain = clamp(opts.duck_gain.unwrap_or(1.0), 0.0, 1.0);
        if !opts.new_instance {
            self.voices.retain(|_, v| &*v.cue_id != cue_id);
        }
        let patch = opts
            .output_patch
            .as_deref()
            .unwrap_or(&[Some(0.0), Some(1.0)]);
        let first = patch.first().copied().flatten();
        let second = patch.get(1).copied().flatten();
        let last = self.channel_count - 1.0;
        self.voice_counter += 1;
        let voice_id: Arc<str> = format!("{cue_id}#{}", self.voice_counter).into();
        let start_gain = if fade_in_time > 0.0 { 0.0 } else { volume };
        let voice = Voice {
            cue_id: cue_id.into(),
            voice_id: voice_id.clone(),
            buffer,
            channels,
            sample_rate,
            trim_start_frame,
            trim_end_frame,
            position: trim_start_frame,
            loop_: opts.loop_,
            output_patch: [
                clamp(first.unwrap_or(0.0), 0.0, last),
                clamp(second.or(first).unwrap_or(1.0), 0.0, last),
            ],
            volume,
            current_gain: start_gain,
            gain_target: volume,
            gain_step: compute_gain_step(start_gain, volume, fade_in_time, sample_rate),
            duck_gain,
            duck_target: duck_gain,
            duck_step: 0.0,
            stopping: false,
            is_paused: false,
            next: None,
            peak_accum: 0.0,
        };
        self.voices.insert(voice_id.clone(), voice);
        voice_id
    }

    /// `queueNext`: what the cue's newest voice plays when it reaches its end (WO-006).
    pub fn queue_next(&mut self, cue_id: &str, buffer: Arc<[f32]>, opts: &PlayOptions) -> bool {
        let channels = or(opts.channels, 2.0);
        let default_rate = self.sample_rate;
        let Some(voice) = self
            .voices
            .values_mut()
            .filter(|v| &*v.cue_id == cue_id)
            .last()
        else {
            return false;
        };
        if voice.stopping {
            return false;
        }
        let sample_rate = or(opts.sample_rate, default_rate);
        let (trim_start_frame, trim_end_frame) = trims(buffer.len(), channels, sample_rate, opts);
        voice.next = Some(Segment {
            buffer,
            channels,
            sample_rate,
            trim_start_frame,
            trim_end_frame,
            token: opts.token.clone(),
        });
        true
    }

    pub fn clear_next(&mut self, cue_id: &str) {
        for v in self.voices.values_mut().filter(|v| &*v.cue_id == cue_id) {
            v.next = None;
        }
    }

    /// `stopCue(cueId, fadeOutSeconds = 0)`: at once (silently) or by fading out.
    pub fn stop_cue(&mut self, cue_id: &str, fade_out_seconds: f64) -> bool {
        if !self.has_cue(cue_id) {
            return false;
        }
        if fade_out_seconds <= 0.0 {
            self.voices.retain(|_, v| &*v.cue_id != cue_id);
            return true;
        }
        for v in self.voices.values_mut().filter(|v| &*v.cue_id == cue_id) {
            v.next = None;
            v.stopping = true;
            v.gain_target = 0.0;
            v.gain_step = compute_gain_step(v.current_gain, 0.0, fade_out_seconds, v.sample_rate);
        }
        true
    }

    pub fn stop_all(&mut self, fade_out_seconds: f64) {
        let mut cue_ids: Vec<Arc<str>> = Vec::new();
        for v in self.voices.values() {
            if !cue_ids.contains(&v.cue_id) {
                cue_ids.push(v.cue_id.clone());
            }
        }
        for cue_id in cue_ids {
            self.stop_cue(&cue_id, fade_out_seconds);
        }
    }

    /// `setGain(cueId, volume, rampSeconds = 0.05)`: a voice fading out keeps fading.
    pub fn set_gain(&mut self, cue_id: &str, volume: f64, ramp_seconds: f64) -> bool {
        let mut any = false;
        for v in self.voices.values_mut().filter(|v| &*v.cue_id == cue_id) {
            any = true;
            v.volume = volume;
            if v.stopping {
                continue;
            }
            v.gain_target = volume;
            v.gain_step = compute_gain_step(v.current_gain, volume, ramp_seconds, v.sample_rate);
        }
        any
    }

    /// `setDuck(cueId, multiplier, fadeSeconds = 0)`.
    pub fn set_duck(&mut self, cue_id: &str, multiplier: f64, fade_seconds: f64) -> bool {
        let target = clamp(multiplier, 0.0, 1.0);
        let mut any = false;
        for v in self.voices.values_mut().filter(|v| &*v.cue_id == cue_id) {
            any = true;
            v.duck_target = target;
            v.duck_step = compute_gain_step(v.duck_gain, target, fade_seconds, v.sample_rate);
        }
        any
    }

    fn set_paused(&mut self, cue_id: &str, paused: bool) -> bool {
        let mut any = false;
        for v in self.voices.values_mut() {
            if &*v.cue_id == cue_id && v.is_paused != paused {
                v.is_paused = paused;
                any = true;
            }
        }
        any
    }

    pub fn pause_cue(&mut self, cue_id: &str) -> bool {
        self.set_paused(cue_id, true)
    }

    pub fn resume_cue(&mut self, cue_id: &str) -> bool {
        self.set_paused(cue_id, false)
    }

    pub fn status(&self) -> MixerStatus {
        let playing = self
            .voices
            .values()
            .map(|v| {
                let ramping = v.gain_step != 0.0 && v.gain_target != v.current_gain;
                VoiceStatus {
                    cue_id: v.cue_id.clone(),
                    voice_id: v.voice_id.clone(),
                    is_paused: v.is_paused,
                    stopping: v.stopping,
                    is_fading_out: ramping && v.stopping,
                    is_fading_in: ramping && !v.stopping && v.gain_step > 0.0,
                    fade_remaining_sec: if ramping {
                        ramp_remaining_sec(
                            v.current_gain,
                            v.gain_target,
                            v.gain_step,
                            v.sample_rate,
                        )
                    } else {
                        0.0
                    },
                    is_ducked: v.duck_target < 1.0,
                    duck_gain: v.duck_gain,
                    position_sec: v.position / v.sample_rate,
                    trim_start_sec: v.trim_start_frame / v.sample_rate,
                    trim_end_sec: v.trim_end_frame / v.sample_rate,
                    volume: v.volume,
                    current_gain: v.current_gain,
                    output_patch: v.output_patch,
                }
            })
            .collect();
        MixerStatus {
            sample_rate: self.sample_rate,
            channel_count: self.channel_count,
            active_count: self.voices.len(),
            master_gain: self.master_gain,
            playing,
        }
    }

    /// `drainPeakLevels`: the loudest output per cue since the last drain, in first-seen order.
    pub fn drain_peak_levels(&mut self) -> Vec<(Arc<str>, f64)> {
        let mut levels: Vec<(Arc<str>, f64)> = Vec::new();
        for v in self.voices.values_mut() {
            let level = if v.is_paused { 0.0 } else { v.peak_accum };
            match levels.iter_mut().find(|(c, _)| *c == v.cue_id) {
                Some((_, l)) => *l = js_max(or(Some(*l), 0.0), level),
                None => levels.push((v.cue_id.clone(), js_max(0.0, level))),
            }
            v.peak_accum = 0.0;
        }
        levels
    }

    /// The events of the last [`Mixer::render`], in callback order.
    pub fn events(&self) -> &[MixerEvent] {
        &self.events
    }

    /// `render(outputBuffer, nFrames, nChannels)`: zeroes `out` and mixes every voice into it.
    pub fn render(&mut self, out: &mut [f32], n_frames: usize, n_channels: usize) {
        out.fill(0.0);
        self.events.clear();
        self.removals.clear();
        let master = self.master_gain;
        let n_ch = n_channels as f64;
        for (index, v) in self.voices.values_mut().enumerate() {
            if v.is_paused {
                continue;
            }
            let [patch_l, patch_r] = v.output_patch;
            for f in 0..n_frames {
                if v.position >= v.trim_end_frame {
                    if v.loop_ {
                        v.position = v.trim_start_frame;
                    } else if let Some(next) = v.next.take() {
                        v.buffer = next.buffer;
                        v.channels = next.channels;
                        v.sample_rate = next.sample_rate;
                        v.trim_start_frame = next.trim_start_frame;
                        v.trim_end_frame = next.trim_end_frame;
                        v.position = next.trim_start_frame;
                        self.events.push(MixerEvent::Advance {
                            cue_id: v.cue_id.clone(),
                            token: next.token,
                        });
                    } else {
                        self.removals.push((index, "completed"));
                        break;
                    }
                }
                let idx = v.position * v.channels;
                // Non-finite samples (NaN, +/-Infinity) are silenced on both sides, -0 reads as 0,
                // and a missing right sample falls back to the left (WO-018). On a 1-channel
                // buffer `idx + 1` is the next frame, as in the original.
                let finite = |x: f32| {
                    if x.is_finite() && x != 0.0 {
                        f64::from(x)
                    } else {
                        0.0
                    }
                };
                let left = element(&v.buffer, idx).map_or(0.0, finite);
                let right = element(&v.buffer, idx + 1.0).map_or(left, finite);
                let vol = v.current_gain * v.duck_gain * master;
                let mut out_l = left * vol;
                let mut out_r = right * vol;
                let base = f as f64 * n_ch;
                if patch_r != patch_l {
                    add_to(out, base + patch_l, out_l);
                    add_to(out, base + patch_r, out_r);
                } else {
                    // Both sides to one output: fold down, half of each (WO-005).
                    out_l = (out_l + out_r) * 0.5;
                    out_r = out_l;
                    add_to(out, base + patch_l, out_l);
                }
                let abs_l = if out_l < 0.0 { -out_l } else { out_l };
                let abs_r = if out_r < 0.0 { -out_r } else { out_r };
                if abs_l > v.peak_accum {
                    v.peak_accum = abs_l;
                }
                if abs_r > v.peak_accum {
                    v.peak_accum = abs_r;
                }
                v.position += 1.0;
                if v.duck_gain != v.duck_target {
                    v.duck_gain = step_ramp(v.duck_gain, v.duck_target, v.duck_step);
                }
                if v.gain_target != v.current_gain {
                    v.current_gain = step_ramp(v.current_gain, v.gain_target, v.gain_step);
                }
                if v.stopping && v.current_gain == 0.0 {
                    self.removals.push((index, "stopped"));
                    break;
                }
            }
        }
        // In iteration order, so "the cue's last voice" is decided as the original decides it.
        for (removed, &(index, reason)) in self.removals.iter().enumerate() {
            if let Some((_, voice)) = self.voices.shift_remove_index(index - removed) {
                let cue_id = voice.cue_id;
                if !self.voices.values().any(|v| v.cue_id == cue_id) {
                    self.events.push(MixerEvent::Complete { cue_id, reason });
                }
            }
        }
    }
}

// ---- the driver (`runMixer` in the shim) ----------------------------------------------------

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(js::as_number)
}

/// JS truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(v) => js::as_number(v).is_none_or(|n| n != 0.0 && !n.is_nan()),
    }
}

fn play_options(v: Option<&Value>) -> PlayOptions {
    let get = |k: &str| v.and_then(|o| o.get(k));
    PlayOptions {
        channels: num(get("channels")),
        sample_rate: num(get("sampleRate")),
        trim_start_time: num(get("trimStartTime")),
        trim_end_time: num(get("trimEndTime")),
        volume: num(get("volume")),
        fade_in_time: num(get("fadeInTime")),
        output_patch: get("outputPatch")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js::as_number).collect()),
        duck_gain: num(get("duckGain")),
        new_instance: truthy(get("newInstance")),
        loop_: truthy(get("loop")),
        token: get("token").cloned(),
    }
}

fn status_json(s: &MixerStatus) -> Value {
    let playing: Vec<Value> = s
        .playing
        .iter()
        .map(|p| {
            json!({
                "cueId": &*p.cue_id, "voiceId": &*p.voice_id, "isPaused": p.is_paused,
                "stopping": p.stopping, "isFadingOut": p.is_fading_out, "isFadingIn": p.is_fading_in,
                "fadeRemainingSec": js::number(p.fade_remaining_sec), "isDucked": p.is_ducked,
                "duckGain": js::number(p.duck_gain), "positionSec": js::number(p.position_sec),
                "trimStartSec": js::number(p.trim_start_sec), "trimEndSec": js::number(p.trim_end_sec),
                "volume": js::number(p.volume), "currentGain": js::number(p.current_gain),
                "outputPatch": [js::number(p.output_patch[0]), js::number(p.output_patch[1])],
            })
        })
        .collect();
    json!({
        "sampleRate": js::number(s.sample_rate), "channelCount": js::number(s.channel_count),
        "activeCount": s.active_count, "masterGain": js::number(s.master_gain), "playing": playing,
    })
}

fn command(mixer: &mut Mixer, buffers: &[Arc<[f32]>], cmd: &Value) -> Value {
    let cue = cmd
        .get("cue")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    let buffer = || {
        let i = num(cmd.get("source")).unwrap_or(0.0);
        buffers
            .get(i as usize)
            .cloned()
            .unwrap_or_else(|| Arc::from(Vec::new()))
    };
    let opts = || play_options(cmd.get("options"));
    let value = num(cmd.get("value")).unwrap_or(f64::NAN);
    let secs = num(cmd.get("seconds"));
    match cmd.get("op").and_then(Value::as_str).unwrap_or("") {
        "play" => Value::from(&*mixer.play_cue(cue, buffer(), &opts())),
        "queueNext" => Value::from(mixer.queue_next(cue, buffer(), &opts())),
        "clearNext" => {
            mixer.clear_next(cue);
            Value::Null
        }
        "stop" => Value::from(mixer.stop_cue(cue, secs.unwrap_or(0.0))),
        "stopAll" => {
            mixer.stop_all(secs.unwrap_or(0.0));
            Value::Null
        }
        "setGain" => Value::from(mixer.set_gain(cue, value, secs.unwrap_or(0.05))),
        "setDuck" => Value::from(mixer.set_duck(cue, value, secs.unwrap_or(0.0))),
        "pause" => Value::from(mixer.pause_cue(cue)),
        "resume" => Value::from(mixer.resume_cue(cue)),
        "setMasterGain" => {
            mixer.set_master_gain(value);
            js::number(mixer.master_gain)
        }
        "setChannelCount" => {
            mixer.channel_count = value;
            Value::Null
        }
        "setSampleRate" => {
            mixer.sample_rate = value;
            Value::Null
        }
        "hasCue" => Value::from(mixer.has_cue(cue)),
        "voiceCount" => Value::from(mixer.voice_count(cue)),
        _ => Value::from("unknown op"),
    }
}

/// Port of `runMixer` (`rust/shims/soundboard-mixer/index.ts`): the deterministic driver.
pub fn run_mixer(
    sample_rate: f64,
    channel_count: f64,
    sources: Vec<Value>,
    commands: Vec<Value>,
    blocks: f64,
    frames: f64,
) -> Result<Value, String> {
    let mut mixer = Mixer::new(sample_rate, channel_count);
    let buffers: Vec<Arc<[f32]>> = sources
        .iter()
        .map(|s| {
            let samples = s.get("samples").and_then(Value::as_array);
            samples
                .into_iter()
                .flatten()
                .map(|x| js::as_number(x).unwrap_or(f64::NAN) as f32)
                .collect()
        })
        .collect();
    let (mut output, mut events, mut returns, mut status, mut peaks) =
        (vec![], vec![], vec![], vec![], vec![]);
    let frames = frames as usize;
    let mut block = 0.0;
    while block < blocks {
        for cmd in &commands {
            if num(cmd.get("block")) == Some(block) {
                let result = command(&mut mixer, &buffers, cmd);
                returns.push(
                    json!({ "block": js::number(block), "op": cmd.get("op"), "result": result }),
                );
            }
        }
        let n_channels = mixer.channel_count as usize;
        let mut out = vec![0.0f32; frames * n_channels];
        mixer.render(&mut out, frames, n_channels);
        for event in mixer.events() {
            events.push(match event {
                MixerEvent::Advance { cue_id, token } => json!({
                    "block": js::number(block), "type": "advance", "cueId": &**cue_id,
                    "token": token.clone().unwrap_or(Value::Null),
                }),
                MixerEvent::Complete { cue_id, reason } => json!({
                    "block": js::number(block), "type": "complete", "cueId": &**cue_id, "reason": reason,
                }),
            });
        }
        output.push(Value::Array(
            out.iter()
                .map(|&x| {
                    if x.is_nan() {
                        Value::Null
                    } else {
                        js::number(f64::from(x))
                    }
                })
                .collect(),
        ));
        status.push(status_json(&mixer.status()));
        let mut levels = Map::new();
        for (cue_id, level) in mixer.drain_peak_levels() {
            levels.insert(cue_id.to_string(), js::number(level));
        }
        peaks.push(Value::Object(levels));
        block += 1.0;
    }
    Ok(
        json!({ "output": output, "events": events, "returns": returns, "status": status, "peaks": peaks }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo(samples: &[f32]) -> Arc<[f32]> {
        Arc::from(samples.to_vec())
    }

    #[test]
    fn js_min_max_propagate_nan_and_order_zeros() {
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative());
    }

    #[test]
    fn both_sides_to_one_output_fold_at_half() {
        let mut m = Mixer::new(1000.0, 2.0);
        let opts = PlayOptions {
            output_patch: Some(vec![Some(0.0), Some(0.0)]),
            ..PlayOptions::default()
        };
        m.play_cue("a", stereo(&[0.5, 0.25, 0.5, 0.25]), &opts);
        let mut out = [0.0f32; 4];
        m.render(&mut out, 2, 2);
        assert_eq!(out, [0.375, 0.0, 0.375, 0.0]);
    }

    #[test]
    fn last_voice_ending_completes_the_cue_once() {
        let mut m = Mixer::new(1000.0, 2.0);
        m.play_cue("a", stereo(&[0.1, 0.1]), &PlayOptions::default());
        let layered = PlayOptions {
            new_instance: true,
            ..PlayOptions::default()
        };
        m.play_cue("a", stereo(&[0.1, 0.1, 0.1, 0.1]), &layered);
        let mut out = [0.0f32; 8];
        m.render(&mut out, 4, 2);
        assert_eq!(
            m.events(),
            [MixerEvent::Complete {
                cue_id: "a".into(),
                reason: "completed"
            }]
        );
        assert!(!m.has_cue("a"));
    }

    #[test]
    fn non_finite_samples_are_silenced_on_both_sides() {
        let mut m = Mixer::new(1000.0, 2.0);
        m.play_cue(
            "a",
            stereo(&[f32::NAN, f32::INFINITY]),
            &PlayOptions::default(),
        );
        let mut out = [0.0f32; 2];
        m.render(&mut out, 1, 2);
        assert_eq!(out, [0.0, 0.0]);
    }
}
