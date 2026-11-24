//! The audio engine (B4): `audioPlaybackManager.js` + `workerMixer.js` + `audioEngineWorker.js`
//! on cpal, behind the cue engine's [`AudioEngine`] trait.
//!
//! Threads, as in the original:
//! - the caller (the core, under its lock) runs the `AudioPlaybackManager` and `WorkerMixer`
//!   bookkeeping: what plays, sequence numbers, queued items, the decoded-buffer LRU;
//! - the audio callback (cpal's real-time thread) owns the mixer (`rust/soundboard-mixer`'s port):
//!   it takes commands from a lock-free queue (rtrb), renders, sends advance/complete events back
//!   on another, and every ~40 ms (and after commands) publishes a status report;
//! - a host thread owns the cpal stream (it isn't `Send` on every platform): it opens and closes
//!   it on request, like the worker's `open`/`close`.
//!
//! The callback never blocks: the mixer state sits in a mutex the callback only `try_lock`s (no one
//! else takes it while a stream runs: the core applies commands itself only when no stream does),
//! and the status report is written with `try_lock` too (skipped for one period if the core is
//! reading it). Rendering and status reports don't allocate; applying a play or queue command
//! does (ids, the voice's entry), as the original's worker did.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use indexmap::IndexMap;
use rtrb::{Consumer, Producer, RingBuffer};
use serde_json::{Value, json};

use super::decode::{Decoded, decode_to_float32};
use super::devices::{DeviceInfo, Registry};
use super::pcm_cache;
use crate::core::cue_engine::{AudioEngine, EngineEvent, js_max, js_min, strict_eq};
use crate::core::jsv::{self, Obj};
use crate::core::lru_cache::LruCache;
use crate::core::output_patch::normalize_output_patch;
use crate::core::soundboard_mixer::{Mixer, MixerEvent, PlayOptions, VoiceStatus};
use crate::js;

const STATUS_INTERVAL_SEC: f64 = 0.04;
/// How often the dropout counts are logged, when there are any (`DROPOUT_REPORT_INTERVAL_MS`).
const DROPOUT_REPORT_INTERVAL: Duration = Duration::from_secs(5);
/// Automatic reopens after a stream error (WO-025): at most this many within the window, so two
/// apps insisting on different rates for one device don't flip it back and forth for ever.
const MAX_REOPENS: usize = 3;
const REOPEN_WINDOW: Duration = Duration::from_secs(10);
const QUEUE: usize = 4096;
/// Largest callback the scratch buffer covers without chunking.
const SCRATCH_FRAMES: usize = 8192;

/// A command for the audio thread (`WorkerMixer._post`).
enum Cmd {
    Play {
        cue: Arc<str>,
        seq: u64,
        buffer: Arc<[f32]>,
        opts: Box<PlayOptions>,
    },
    QueueNext {
        cue: Arc<str>,
        buffer: Arc<[f32]>,
        opts: Box<PlayOptions>,
    },
    ClearNext(Arc<str>),
    Stop(Arc<str>, f64),
    SetGain(Arc<str>, f64, f64),
    SetDuck(Arc<str>, f64, f64),
    Pause(Arc<str>),
    Resume(Arc<str>),
    Master(f64),
    Format(Option<f64>, Option<f64>),
}

/// What the audio thread reports back (`complete` / `advanced` messages, with the play's seq).
enum AudioEvent {
    Complete {
        cue: Arc<str>,
        reason: &'static str,
        seq: Option<u64>,
    },
    Advanced {
        cue: Arc<str>,
        token: Option<Value>,
        seq: Option<u64>,
    },
}

/// The worker's `status` message: voices (with the seq the audio thread knows for their cue) and
/// the peak levels since the last report.
#[derive(Default)]
struct Report {
    voices: Vec<(VoiceStatus, Option<u64>)>,
    peaks: Vec<(Arc<str>, f64)>,
    fresh: bool,
    /// How many commands the audio thread had applied when it wrote this report.
    applied: u64,
}

/// The audio thread's side: the mixer and its queues (`audioEngineWorker.js`).
struct AudioState {
    mixer: Mixer,
    cmds: Consumer<Cmd>,
    events: Producer<AudioEvent>,
    play_seqs: std::collections::HashMap<Arc<str>, u64>,
    report: Arc<Mutex<Report>>,
    voice_buf: Vec<VoiceStatus>,
    peak_buf: Vec<(Arc<str>, f64)>,
    scratch: Vec<f32>,
    frames_since_status: f64,
    status_due: bool,
    was_active: bool,
    applied: u64,
}

impl AudioState {
    fn apply(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Play {
                cue,
                seq,
                buffer,
                opts,
            } => {
                self.play_seqs.insert(cue.clone(), seq);
                self.mixer.play_cue(&cue, buffer, &opts);
            }
            Cmd::QueueNext { cue, buffer, opts } => {
                self.mixer.queue_next(&cue, buffer, &opts);
            }
            Cmd::ClearNext(cue) => self.mixer.clear_next(&cue),
            Cmd::Stop(cue, fade) => {
                self.mixer.stop_cue(&cue, fade);
                if !self.mixer.has_cue(&cue) {
                    self.play_seqs.remove(&cue);
                }
            }
            Cmd::SetGain(cue, volume, ramp) => {
                self.mixer.set_gain(&cue, volume, ramp);
            }
            Cmd::SetDuck(cue, m, fade) => {
                self.mixer.set_duck(&cue, m, fade);
            }
            Cmd::Pause(cue) => {
                self.mixer.pause_cue(&cue);
            }
            Cmd::Resume(cue) => {
                self.mixer.resume_cue(&cue);
            }
            Cmd::Master(v) => self.mixer.set_master_gain(v),
            Cmd::Format(rate, channels) => {
                if let Some(r) = rate.filter(|r| *r != 0.0 && !r.is_nan()) {
                    self.mixer.sample_rate = r;
                }
                if let Some(c) = channels.filter(|c| *c != 0.0 && !c.is_nan()) {
                    self.mixer.channel_count = c;
                }
            }
        }
        self.applied += 1;
        self.status_due = true;
    }

    fn drain_commands(&mut self) {
        while let Ok(cmd) = self.cmds.pop() {
            self.apply(cmd);
        }
    }

    fn forward_events(&mut self) {
        for i in 0..self.mixer.events().len() {
            let event = match &self.mixer.events()[i] {
                MixerEvent::Advance { cue_id, token } => AudioEvent::Advanced {
                    cue: cue_id.clone(),
                    token: token.clone(),
                    seq: self.play_seqs.get(cue_id).copied(),
                },
                MixerEvent::Complete { cue_id, reason } => AudioEvent::Complete {
                    cue: cue_id.clone(),
                    reason,
                    seq: self.play_seqs.remove(cue_id),
                },
            };
            let _ = self.events.push(event);
        }
    }

    /// `sendStatus()`: only while something plays, and once more after it stops.
    fn publish_status(&mut self) {
        let active = self.mixer.active_count() > 0;
        let Ok(mut report) = self.report.try_lock() else {
            return; // the core is reading it: next period
        };
        report.applied = self.applied;
        self.status_due = false;
        self.frames_since_status = 0.0;
        if !active && !self.was_active {
            return;
        }
        self.was_active = active;
        self.mixer.status_into(&mut self.voice_buf);
        report.voices.clear();
        for v in self.voice_buf.drain(..) {
            let seq = self.play_seqs.get(&v.cue_id).copied();
            report.voices.push((v, seq));
        }
        self.mixer.drain_peak_levels_into(&mut self.peak_buf);
        for (cue, level) in self.peak_buf.drain(..) {
            match report.peaks.iter_mut().find(|(c, _)| *c == cue) {
                Some((_, l)) => *l = l.max(level),
                None => report.peaks.push((cue, level)),
            }
        }
        report.fresh = true;
    }

    /// One callback: commands, render (`device_channels` wide), events, status.
    fn render(&mut self, out: &mut [f32], device_channels: usize) {
        self.drain_commands();
        let cc = (self.mixer.channel_count as usize).clamp(1, device_channels.max(1));
        let frames = out.len() / device_channels.max(1);
        if cc == device_channels {
            self.mixer.render(out, frames, cc);
            self.forward_events();
        } else {
            // The device is wider than the engine's channel count (ADR-018): render the engine's
            // channels and leave the rest silent.
            out.fill(0.0);
            let mut done = 0;
            while done < frames {
                let n = (frames - done).min(SCRATCH_FRAMES);
                let scratch = &mut self.scratch[..n * cc];
                self.mixer.render(scratch, n, cc);
                for f in 0..n {
                    let dst = (done + f) * device_channels;
                    out[dst..dst + cc].copy_from_slice(&scratch[f * cc..f * cc + cc]);
                }
                self.forward_events();
                done += n;
            }
        }
        self.frames_since_status += frames as f64;
        if self.status_due
            || self.frames_since_status >= self.mixer.sample_rate * STATUS_INTERVAL_SEC
        {
            self.publish_status();
        }
    }
}

/// A request for the host thread that owns the cpal stream.
enum HostReq {
    Open {
        device: DeviceInfo,
        channels: u16,
        /// None: whatever rate the device runs at now (a reopen after an error, WO-025).
        sample_rate: Option<u32>,
        buffer_size: u32,
        state: Arc<Mutex<AudioState>>,
        alive: Arc<AtomicBool>,
        errors: Arc<Mutex<Vec<Value>>>,
        dropouts: Arc<Dropouts>,
        reply: mpsc::Sender<Result<(String, u32), String>>,
    },
    Close(mpsc::Sender<()>),
}

fn host_thread(rx: mpsc::Receiver<HostReq>) {
    let mut stream: Option<cpal::Stream> = None;
    while let Ok(req) = rx.recv() {
        match req {
            HostReq::Open {
                device,
                channels,
                sample_rate,
                buffer_size,
                state,
                alive,
                errors,
                dropouts,
                reply,
            } => {
                stream = None; // close the old one first
                alive.store(false, Ordering::SeqCst);
                let result = open_stream(
                    &device,
                    channels,
                    sample_rate,
                    buffer_size,
                    state,
                    alive.clone(),
                    errors,
                    dropouts,
                );
                let _ = reply.send(match result {
                    Ok((s, rate)) => {
                        stream = Some(s);
                        alive.store(true, Ordering::SeqCst);
                        Ok((device.name.clone(), rate))
                    }
                    Err(e) => Err(e),
                });
            }
            HostReq::Close(reply) => {
                stream = None;
                let _ = reply.send(());
            }
        }
    }
    drop(stream);
}

fn cpal_device(info: &DeviceInfo) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    #[cfg(target_os = "macos")]
    let want = cpal::DeviceId::new(host.id(), &info.cpal_id).to_string();
    #[cfg(not(target_os = "macos"))]
    let want = info.cpal_id.clone();
    let is_want = |d: &cpal::Device| d.id().map(|i| i.to_string()).as_deref() == Ok(want.as_str());
    host.devices()
        .map_err(|e| e.to_string())?
        .find(is_want)
        // ALSA's "default" may not be listed (WO-042, devices.rs `probe`).
        .or_else(|| host.default_output_device().filter(is_want))
        .ok_or_else(|| format!("Output device not found: {}", info.name))
}

/// Dropout accounting (`audioEngineWorker.js`' `dropouts`, WO-029): underflows the driver
/// reported (cpal's `Xrun`) and callbacks that came more than two periods after the previous one.
#[derive(Default)]
struct Dropouts {
    underflows: AtomicU64,
    late: AtomicU64,
    /// The worst gap between callbacks, in microseconds.
    worst_gap_us: AtomicU64,
    /// The latest callback's period, in microseconds.
    period_us: AtomicU64,
}

impl Dropouts {
    /// The counts since the last call, as the worker's `dropouts` log line; None when there were
    /// none (`WorkerMixer._onMessage`, case 'dropouts').
    fn take_report(&self, interval: Duration) -> Option<String> {
        let underflows = self.underflows.swap(0, Ordering::Relaxed);
        let late = self.late.swap(0, Ordering::Relaxed);
        let worst_ms = self.worst_gap_us.swap(0, Ordering::Relaxed) as f64 / 1000.0;
        if underflows == 0 && late == 0 {
            return None;
        }
        let period_ms = self.period_us.load(Ordering::Relaxed) as f64 / 1000.0;
        Some(format!(
            "WorkerMixer: Audio dropouts in the last {}s: {underflows} underflow(s) reported by the \
             driver, {late} late buffer(s) (worst gap {worst_ms:.1} ms, buffer period {period_ms:.1} ms)",
            interval.as_secs_f64()
        ))
    }
}

/// When the previous callback came, to count late ones (lives in the audio callback).
#[derive(Default)]
struct CallbackClock {
    last: Option<Instant>,
}

impl CallbackClock {
    fn tick(&mut self, now: Instant, period: Duration, dropouts: &Dropouts) {
        if let Some(last) = self.last {
            let gap = now.saturating_duration_since(last);
            if gap > period * 2 {
                dropouts.late.fetch_add(1, Ordering::Relaxed);
                dropouts
                    .worst_gap_us
                    .fetch_max(gap.as_micros() as u64, Ordering::Relaxed);
            }
        }
        dropouts
            .period_us
            .store(period.as_micros() as u64, Ordering::Relaxed);
        self.last = Some(now);
    }
}

/// The stream's error callback. cpal reports fatal and harmless errors alike through it (WO-028):
/// an overload is a dropout, counted for the report; a default-device change leaves the stream
/// running; anything else stopped the stream.
fn stream_error(
    err: &cpal::Error,
    alive: &AtomicBool,
    errors: &Mutex<Vec<Value>>,
    dropouts: &Dropouts,
) {
    match err.kind() {
        cpal::ErrorKind::Xrun => {
            dropouts.underflows.fetch_add(1, Ordering::Relaxed);
        }
        cpal::ErrorKind::DeviceChanged => {
            eprintln!("AudioEngineWorker: {err} (the stream carries on)");
        }
        kind => {
            alive.store(false, Ordering::SeqCst);
            if let Ok(mut list) = errors.lock() {
                list.push(json!({ "type": format!("{kind:?}"), "message": err.to_string() }));
            }
        }
    }
}

fn open_stream(
    info: &DeviceInfo,
    engine_channels: u16,
    sample_rate: Option<u32>,
    buffer_size: u32,
    state: Arc<Mutex<AudioState>>,
    alive: Arc<AtomicBool>,
    errors: Arc<Mutex<Vec<Value>>>,
    dropouts: Arc<Dropouts>,
) -> Result<(cpal::Stream, u32), String> {
    let device = cpal_device(info)?;
    // Following the device's current rate doesn't set it, so other apps' streams on the device
    // aren't disturbed (RtAudio's stream simply carries on at the new rate).
    let sample_rate = match sample_rate {
        Some(rate) => rate,
        None => device
            .default_output_config()
            .map_err(|e| e.to_string())?
            .sample_rate(),
    };
    // Opened at the device's full width (ADR-018); the engine's channels come first.
    let device_channels = (info.output_channels as u16).max(engine_channels).max(1);
    // RtAudio clamps the buffer size into the device's range; cpal refuses one outside it.
    let mut buffer = buffer_size.max(1);
    if let Ok(configs) = device.supported_output_configs() {
        for c in configs {
            if u32::from(c.channels()) == u32::from(device_channels)
                && let cpal::SupportedBufferSize::Range { min, max } = c.buffer_size()
            {
                buffer = buffer.clamp(*min, *max);
                break;
            }
        }
    }
    let config = cpal::StreamConfig {
        channels: device_channels,
        sample_rate,
        buffer_size: cpal::BufferSize::Fixed(buffer),
    };
    let dc = usize::from(device_channels);
    let err_alive = alive.clone();
    let err_dropouts = dropouts.clone();
    let mut clock = CallbackClock::default();
    let rate = f64::from(sample_rate.max(1));
    let stream = device
        .build_output_stream::<f32, _, _>(
            config,
            move |data: &mut [f32], _| {
                let frames = data.len() / dc.max(1);
                let period = Duration::from_secs_f64(frames as f64 / rate);
                clock.tick(Instant::now(), period, &dropouts);
                match state.try_lock() {
                    Ok(mut st) => st.render(data, dc),
                    Err(_) => data.fill(0.0),
                }
            },
            move |err| stream_error(&err, &err_alive, &errors, &err_dropouts),
            Some(Duration::from_secs(2)),
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, sample_rate))
}

/// `WorkerMixer._cues`' entry: voices, paused, the seq of the cue's latest play.
#[derive(Clone)]
struct CueTrack {
    voices: usize,
    paused: bool,
    seq: u64,
}

/// `playingCues`' entry (`playbackInfo`).
#[derive(Clone)]
struct PlaybackInfo {
    file_path: Value,
    trim_start_time: Value,
    trim_end_time: Value,
    volume: Value,
    fade_in_time: Value,
    fade_out_time: Value,
    loop_: Value,
    is_paused: bool,
    output_patch: Vec<f64>,
}

#[derive(Clone)]
struct QueuedNext {
    file_path: Value,
    trim_start_time: Value,
    trim_end_time: Value,
    token: Value,
}

#[derive(Clone)]
struct Loaded {
    buffer: Arc<[f32]>,
    sample_rate: u32,
    channels: usize,
    duration_sec: f64,
}

/// The engine: `AudioPlaybackManager` + `WorkerMixer`.
pub struct CpalEngine {
    registry: Registry,
    host: mpsc::Sender<HostReq>,
    state: Option<Arc<Mutex<AudioState>>>,
    cmd_tx: Option<Producer<Cmd>>,
    event_rx: Option<Consumer<AudioEvent>>,
    report: Arc<Mutex<Report>>,
    alive: Arc<AtomicBool>,
    errors: Arc<Mutex<Vec<Value>>>,
    dropouts: Arc<Dropouts>,
    /// When the dropout counts were last logged.
    dropouts_reported_at: Instant,
    /// When the stream was reopened automatically after an error, within `REOPEN_WINDOW`.
    reopens: Vec<Instant>,
    // AudioPlaybackManager
    playing: IndexMap<String, PlaybackInfo>,
    queued_next: std::collections::HashMap<String, QueuedNext>,
    buffers: LruCache<String, Loaded>,
    initialized: bool,
    stream_open: bool,
    init_error: Option<String>,
    sample_rate: Value,
    channel_count: Value,
    buffer_size: Value,
    device_id: Value,
    pcm_cache_dir: Option<String>,
    master: f64,
    // WorkerMixer
    cues: IndexMap<String, CueTrack>,
    seq: u64,
    last_voices: Vec<(VoiceStatus, Option<u64>)>,
    peaks: IndexMap<String, f64>,
    mixer_master: f64,
    pending: Vec<EngineEvent>,
    /// Commands pushed to the audio thread (compared with `Report::applied`).
    posted: u64,
    /// The stream's callback period, for how long `voices` waits on it.
    period_sec: f64,
}

impl Default for CpalEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn n(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, jsv::to_number)
}

fn nullish(v: Option<&Value>) -> bool {
    v.is_none_or(|v| v.is_null() || js::is_undefined(v))
}

/// `a ?? b`.
fn coalesce(v: Option<&Value>, b: Value) -> Value {
    if nullish(v) {
        b
    } else {
        v.cloned().unwrap_or(b)
    }
}

impl CpalEngine {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("audio-host".into())
            .spawn(move || host_thread(rx))
            .expect("starting the audio host thread");
        CpalEngine {
            registry: Registry::new(),
            host: tx,
            state: None,
            cmd_tx: None,
            event_rx: None,
            report: Arc::default(),
            alive: Arc::new(AtomicBool::new(false)),
            errors: Arc::default(),
            dropouts: Arc::default(),
            dropouts_reported_at: Instant::now(),
            reopens: Vec::new(),
            playing: IndexMap::new(),
            queued_next: std::collections::HashMap::new(),
            buffers: LruCache::new(50.0, 512.0 * 1024.0 * 1024.0),
            initialized: false,
            stream_open: false,
            init_error: None,
            sample_rate: json!(48000),
            channel_count: json!(2),
            buffer_size: json!(512),
            device_id: Value::Null,
            pcm_cache_dir: None,
            master: 1.0,
            cues: IndexMap::new(),
            seq: 0,
            last_voices: Vec::new(),
            posted: 0,
            period_sec: 0.0,
            peaks: IndexMap::new(),
            mixer_master: 1.0,
            pending: Vec::new(),
        }
    }

    fn rate_u32(&self) -> u32 {
        let r = jsv::to_number(&self.sample_rate);
        if r.is_finite() && r > 0.0 {
            r as u32
        } else {
            48000
        }
    }

    fn channels_u16(&self) -> u16 {
        let c = jsv::to_number(&self.channel_count);
        if c.is_finite() && c >= 1.0 {
            c as u16
        } else {
            2
        }
    }

    /// `resolveChannelCount(requested, deviceId)`.
    fn resolve_channels(&mut self, requested: Option<&Value>, device: &Value) -> Value {
        let max = self
            .registry
            .by_id(device)
            .map(|d| f64::from(d.output_channels))
            .filter(|c| *c != 0.0)
            .unwrap_or(2.0);
        let channels = jsv::to_number(&jsv::or(requested, json!(2)));
        jsv::num(js_max(1.0, js_min(channels, max)))
    }

    /// `_applyConfigValues`.
    fn apply_values(&mut self, config: &Value) {
        self.sample_rate = jsv::or(config.get("audioSampleRate"), json!(48000));
        self.buffer_size = jsv::or(config.get("audioBufferSize"), json!(512));
        self.pcm_cache_dir = config
            .get("pcmCacheDir")
            .filter(|v| jsv::truthy(v))
            .and_then(Value::as_str)
            .map(str::to_string);
        let spec = config
            .get("audioOutputDeviceId")
            .cloned()
            .unwrap_or(Value::Null);
        self.device_id = self.registry.resolve(&spec);
        let id = self.device_id.clone();
        self.channel_count = self.resolve_channels(config.get("audioOutputChannelCount"), &id);
    }

    /// `_ensureMixer`.
    fn ensure_mixer(&mut self) {
        let rate = jsv::to_number(&self.sample_rate);
        let channels = jsv::to_number(&self.channel_count);
        if self.state.is_some() {
            self.post(Cmd::Format(Some(rate), Some(channels)));
            return;
        }
        let (cmd_tx, cmd_rx) = RingBuffer::new(QUEUE);
        let (evt_tx, evt_rx) = RingBuffer::new(QUEUE);
        let mut mixer = Mixer::new(rate, channels);
        mixer.set_master_gain(self.mixer_master);
        self.report = Arc::default();
        self.posted = 0;
        let state = AudioState {
            mixer,
            cmds: cmd_rx,
            events: evt_tx,
            play_seqs: std::collections::HashMap::with_capacity(256),
            report: self.report.clone(),
            voice_buf: Vec::with_capacity(256),
            peak_buf: Vec::with_capacity(256),
            scratch: vec![0.0; SCRATCH_FRAMES * 64],
            frames_since_status: 0.0,
            status_due: false,
            was_active: false,
            applied: 0,
        };
        self.state = Some(Arc::new(Mutex::new(state)));
        self.cmd_tx = Some(cmd_tx);
        self.event_rx = Some(evt_rx);
        if let Ok(mut r) = self.report.lock() {
            r.voices.reserve(256);
            r.peaks.reserve(256);
        }
    }

    /// `WorkerMixer._post`. With no stream running the audio thread isn't there to take the
    /// command, so it is applied here, as the worker would without a stream.
    fn post(&mut self, cmd: Cmd) {
        let Some(tx) = self.cmd_tx.as_mut() else {
            return;
        };
        if tx.push(cmd).is_err() {
            eprintln!("AudioEngine: command queue full; command dropped");
        } else {
            self.posted += 1;
        }
        self.apply_if_no_stream();
    }

    /// With no stream running (never opened, closed, or died with an error) nothing takes the
    /// commands off the queue; the worker applies them regardless of its stream, so do it here.
    fn apply_if_no_stream(&self) {
        if !self.alive.load(Ordering::SeqCst)
            && let Some(state) = &self.state
            && let Ok(mut st) = state.lock()
        {
            st.drain_commands();
            st.publish_status();
        }
    }

    /// Take what the audio thread reported: events (`complete`, `advanced`), engine errors and
    /// the latest status (`_onMessage`, `_applyStatus`).
    fn sync(&mut self) {
        self.apply_if_no_stream();
        let mut events = Vec::new();
        if let Some(rx) = self.event_rx.as_mut() {
            while let Ok(e) = rx.pop() {
                events.push(e);
            }
        }
        for e in events {
            match e {
                AudioEvent::Complete { cue, reason, seq } => {
                    let cue = cue.to_string();
                    let matches = self.cues.get(&cue).is_some_and(|c| Some(c.seq) == seq);
                    if matches {
                        self.cues.shift_remove(&cue);
                        self.handle_playback_end(&cue, reason);
                    }
                }
                AudioEvent::Advanced { cue, token, seq } => {
                    let cue = cue.to_string();
                    let matches = self.cues.get(&cue).is_some_and(|c| Some(c.seq) == seq);
                    if matches {
                        self.handle_playback_advance(&cue, token.unwrap_or_else(js::undefined));
                    }
                }
            }
        }
        let errors: Vec<Value> = self
            .errors
            .lock()
            .map(|mut l| std::mem::take(&mut *l))
            .unwrap_or_default();
        if !errors.is_empty() {
            for error in &errors {
                eprintln!(
                    "AudioEngineWorker: RtAudio error ({}): {}",
                    jsv::to_js_string(error.get("type").unwrap_or(&Value::Null)),
                    jsv::to_js_string(error.get("message").unwrap_or(&Value::Null))
                );
            }
            self.stream_open = false;
            // RtAudio's stream lives through what kills cpal's (a device rate change): reopen,
            // and the voices carry on (WO-025). Reported to the UI only if that fails.
            if !self.reopen_after_error() {
                self.pending
                    .extend(errors.into_iter().map(EngineEvent::Error));
            }
        }
        if self.dropouts_reported_at.elapsed() >= DROPOUT_REPORT_INTERVAL {
            self.dropouts_reported_at = Instant::now();
            if let Some(line) = self.dropouts.take_report(DROPOUT_REPORT_INTERVAL) {
                eprintln!("{line}");
            }
        }
        let fresh = if let Ok(mut r) = self.report.lock() {
            if r.fresh {
                r.fresh = false;
                self.last_voices.clear();
                self.last_voices.extend(r.voices.iter().cloned());
                let peaks = std::mem::take(&mut r.peaks);
                Some(peaks)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(peaks) = fresh {
            for (cue, level) in peaks {
                let entry = self.peaks.entry(cue.to_string()).or_insert(0.0);
                *entry = entry.max(level);
            }
            let mut counts: IndexMap<String, (usize, Option<u64>)> = IndexMap::new();
            for (v, seq) in &self.last_voices {
                let e = counts.entry(v.cue_id.to_string()).or_insert((0, *seq));
                e.0 += 1;
            }
            for (cue, track) in self.cues.iter_mut() {
                if let Some((count, seq)) = counts.get(cue)
                    && *count > 0
                    && *seq == Some(track.seq)
                {
                    track.voices = *count;
                }
            }
        }
    }

    fn handle_playback_end(&mut self, cue: &str, reason: &str) {
        self.playing.shift_remove(cue);
        self.queued_next.remove(cue);
        self.pending.push(EngineEvent::PlaybackEnd {
            cue_id: cue.to_string(),
            reason: reason.to_string(),
        });
    }

    fn handle_playback_advance(&mut self, cue: &str, token: Value) {
        let next = self.queued_next.get(cue).cloned();
        if let Some(next) = next
            && strict_eq(Some(&next.token), Some(&token))
            && let Some(info) = self.playing.get_mut(cue)
        {
            self.queued_next.remove(cue);
            info.file_path = next.file_path;
            info.trim_start_time = next.trim_start_time;
            info.trim_end_time = next.trim_end_time;
        }
        self.pending.push(EngineEvent::Advance {
            cue_id: cue.to_string(),
            token,
        });
    }

    /// The latest status report, once it reflects every command posted so far. The worker
    /// reports straight after each command, so in the original the voices a request reads right
    /// after a play or stop already show it; here the audio thread applies commands at its next
    /// callback, so wait for that (a few periods at most) rather than report the state before.
    fn settled_report(&self) -> std::sync::MutexGuard<'_, Report> {
        let lock = || self.report.lock().unwrap_or_else(|e| e.into_inner());
        if !self.stream_running() {
            self.apply_if_no_stream();
            return lock();
        }
        let wait = (self.period_sec * 3.0 + 0.02).min(0.2);
        let deadline = Instant::now() + Duration::from_secs_f64(wait);
        // Past the deadline the callback isn't coming (a stream killed but not yet reported
        // dead, or a very long period): apply the commands here (WO-024). The callback only
        // `try_lock`s, so taking the state is safe; if the callback holds it, it is applying
        // them right now - wait for it, up to a hard limit.
        let hard_deadline = deadline + Duration::from_millis(200);
        loop {
            if !self.stream_running() {
                self.apply_if_no_stream();
                return lock();
            }
            let report = lock();
            if report.applied >= self.posted {
                return report;
            }
            drop(report);
            let now = Instant::now();
            if now >= deadline
                && let Some(state) = &self.state
                && let Ok(mut st) = state.try_lock()
            {
                st.drain_commands();
                st.publish_status();
                drop(st);
                return lock();
            }
            if now >= hard_deadline {
                return lock();
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// After a stream error: reopen the stream (WO-025), unless it has been reopened
    /// `MAX_REOPENS` times within `REOPEN_WINDOW` already. True when it is running again.
    fn reopen_after_error(&mut self) -> bool {
        if !self.initialized || self.state.is_none() {
            return false;
        }
        let now = Instant::now();
        self.reopens
            .retain(|t| now.saturating_duration_since(*t) < REOPEN_WINDOW);
        if self.reopens.len() >= MAX_REOPENS {
            eprintln!(
                "AudioPlaybackManager: not reopening the stream: reopened {} times in {} s",
                self.reopens.len(),
                REOPEN_WINDOW.as_secs()
            );
            return false;
        }
        self.reopens.push(now);
        match self.open_at(None) {
            Ok(()) => {
                eprintln!("AudioPlaybackManager: stream reopened after the engine error");
                true
            }
            Err(e) => {
                eprintln!("AudioPlaybackManager: reopening the stream failed: {e}");
                false
            }
        }
    }

    fn stream_running(&self) -> bool {
        self.stream_open && self.alive.load(Ordering::SeqCst)
    }

    /// `_openStream`.
    fn open(&mut self) -> Result<(), String> {
        self.open_at(Some(self.rate_u32()))
    }

    /// Opens the stream at `rate`, or at the device's current rate (None). The mixer keeps the
    /// configured rate either way.
    fn open_at(&mut self, rate: Option<u32>) -> Result<(), String> {
        self.ensure_mixer();
        let device = self
            .registry
            .by_id(&self.device_id)
            .ok_or_else(|| "No audio output device available".to_string())?;
        let (reply, rx) = mpsc::channel();
        let buffer = jsv::to_number(&self.buffer_size);
        self.host
            .send(HostReq::Open {
                device,
                channels: self.channels_u16(),
                sample_rate: rate,
                buffer_size: if buffer.is_finite() && buffer > 0.0 {
                    buffer as u32
                } else {
                    512
                },
                state: self.state.clone().ok_or("Audio engine not initialized")?,
                alive: self.alive.clone(),
                errors: self.errors.clone(),
                dropouts: self.dropouts.clone(),
                reply,
            })
            .map_err(|_| "Audio engine stopped".to_string())?;
        let (name, stream_rate) = rx
            .recv()
            .map_err(|_| "Audio engine stopped".to_string())??;
        self.stream_open = true;
        self.period_sec = f64::from(if buffer.is_finite() && buffer > 0.0 {
            buffer as u32
        } else {
            512
        }) / f64::from(stream_rate.max(1));
        self.init_error = None;
        eprintln!(
            "AudioPlaybackManager: cpal stream open (audio thread) — {name}, {}ch @ {stream_rate}Hz, buffer {}",
            self.channels_u16(),
            jsv::to_number(&self.buffer_size)
        );
        Ok(())
    }

    fn close(&mut self) {
        let (reply, rx) = mpsc::channel();
        if self.host.send(HostReq::Close(reply)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
        self.alive.store(false, Ordering::SeqCst);
        self.stream_open = false;
    }

    /// `ensureStreamOpen`.
    fn ensure_stream_open(&mut self) -> Result<(), String> {
        if !self.initialized {
            return Err(self
                .init_error
                .clone()
                .unwrap_or_else(|| "Audio engine not initialized".into()));
        }
        self.sync();
        if self.stream_running() {
            return Ok(());
        }
        self.open()
    }

    /// `loadAudioBuffer`: the LRU, then the PCM cache, then the decoder.
    fn load(&mut self, file_path: &str) -> Result<Loaded, String> {
        if let Some(l) = self.buffers.get(&file_path.to_string()) {
            return Ok(l.clone());
        }
        let rate = self.rate_u32();
        let decoded: Decoded = match self
            .pcm_cache_dir
            .as_deref()
            .and_then(|dir| pcm_cache::get_cached(file_path, dir, rate))
        {
            Some(d) => d,
            None => decode_to_float32(file_path, rate)?,
        };
        let bytes = (decoded.samples.len() * 4) as f64;
        let loaded = Loaded {
            buffer: Arc::from(decoded.samples.into_boxed_slice()),
            sample_rate: decoded.sample_rate,
            channels: decoded.channels,
            duration_sec: decoded.duration_sec,
        };
        self.buffers
            .set(file_path.to_string(), loaded.clone(), bytes.max(1.0));
        Ok(loaded)
    }

    fn play_options(loaded: &Loaded, info: &PlaybackInfo, options: &Value) -> PlayOptions {
        PlayOptions {
            channels: Some(loaded.channels as f64),
            sample_rate: Some(f64::from(loaded.sample_rate)),
            trim_start_time: Some(n(Some(&info.trim_start_time))),
            trim_end_time: Some(n(Some(&info.trim_end_time))),
            volume: Some(n(Some(&info.volume))),
            fade_in_time: Some(n(Some(&info.fade_in_time))),
            output_patch: Some(info.output_patch.iter().map(|c| Some(*c)).collect()),
            duck_gain: Some(n(Some(&coalesce(options.get("duckGain"), json!(1))))),
            new_instance: jsv::truthy_opt(options.get("newInstance")),
            loop_: jsv::truthy(&info.loop_),
            token: None,
        }
    }

    fn playback_json(cue: &str, info: &PlaybackInfo) -> Value {
        let mut o = Obj::new();
        o.insert("cueId".into(), json!(cue));
        o.insert("filePath".into(), info.file_path.clone());
        o.insert("trimStartTime".into(), info.trim_start_time.clone());
        o.insert("trimEndTime".into(), info.trim_end_time.clone());
        o.insert("volume".into(), info.volume.clone());
        o.insert("fadeInTime".into(), info.fade_in_time.clone());
        o.insert("fadeOutTime".into(), info.fade_out_time.clone());
        o.insert("loop".into(), info.loop_.clone());
        o.insert("isPaused".into(), json!(info.is_paused));
        o.insert(
            "outputPatch".into(),
            Value::Array(info.output_patch.iter().map(|c| jsv::num(*c)).collect()),
        );
        Value::Object(o)
    }

    fn do_play(&mut self, cue: &str, file_path: &Value, options: &Value) -> Result<Value, String> {
        self.ensure_stream_open()?;
        let new_instance = jsv::truthy_opt(options.get("newInstance"));
        if self.playing.contains_key(cue) && !new_instance {
            self.stop_cue_impl(cue, false, None);
        } else if new_instance {
            self.clear_next(cue);
        }
        let path = file_path.as_str().unwrap_or_default().to_string();
        let loaded = self.load(&path)?;
        let trim_start = jsv::or(options.get("trimStartTime"), json!(0));
        let trim_end = coalesce(options.get("trimEndTime"), jsv::num(loaded.duration_sec));
        let patch = normalize_output_patch(
            options
                .get("outputPatch")
                .cloned()
                .unwrap_or_else(js::undefined),
            Some(jsv::to_number(&self.channel_count)),
        )
        .unwrap_or_else(|_| vec![0.0, 1.0]);
        let info = PlaybackInfo {
            file_path: file_path.clone(),
            trim_start_time: trim_start,
            trim_end_time: trim_end,
            volume: coalesce(options.get("volume"), json!(1.0)),
            fade_in_time: jsv::or(options.get("fadeInTime"), json!(0)),
            fade_out_time: jsv::or(options.get("fadeOutTime"), json!(0)),
            loop_: jsv::or(options.get("loop"), json!(false)),
            is_paused: false,
            output_patch: patch,
        };
        let opts = Self::play_options(&loaded, &info, options);
        // WorkerMixer.playCue
        self.seq += 1;
        let seq = self.seq;
        let voices = match self.cues.get(cue) {
            Some(existing) if new_instance => existing.voices + 1,
            _ => 1,
        };
        self.cues.insert(
            cue.to_string(),
            CueTrack {
                voices,
                paused: false,
                seq,
            },
        );
        self.post(Cmd::Play {
            cue: Arc::from(cue),
            seq,
            buffer: loaded.buffer.clone(),
            opts: Box::new(opts),
        });
        let result = Self::playback_json(cue, &info);
        self.playing.insert(cue.to_string(), info);
        Ok(json!({ "success": true, "playbackInfo": result }))
    }

    /// `stopCue(cueId, fadeOut, fadeOverrideSeconds)`.
    fn stop_cue_impl(&mut self, cue: &str, fade_out: bool, override_secs: Option<f64>) -> Value {
        let Some(info) = self.playing.get(cue).cloned() else {
            return json!({ "success": true, "fading": false });
        };
        if self.state.is_none() {
            return json!({ "success": true, "fading": false });
        }
        let mut fade = 0.0;
        if fade_out {
            fade = override_secs.unwrap_or_else(|| n(Some(&info.fade_out_time)));
        }
        if info.is_paused {
            fade = 0.0;
        }
        self.queued_next.remove(cue);
        // WorkerMixer.stopCue
        if self.cues.contains_key(cue) {
            // `!(fadeOutSeconds > 0)`: NaN counts as no fade too.
            if fade.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
                self.cues.shift_remove(cue);
            }
            self.post(Cmd::Stop(Arc::from(cue), fade));
        }
        let fading = fade > 0.0;
        if !fading {
            self.playing.shift_remove(cue);
        }
        json!({ "success": true, "fading": fading })
    }
}

impl AudioEngine for CpalEngine {
    fn init(&mut self, config: &Value) {
        self.apply_values(config);
        self.ensure_mixer();
        self.initialized = true;
        self.stream_open = false;
        self.init_error = None;
        eprintln!(
            "AudioPlaybackManager: Engine ready (device {}, {}ch @ {}Hz — stream opens on playback)",
            self.device_id, self.channel_count, self.sample_rate
        );
    }
    fn set_playback_end_callback(&mut self) {}
    fn set_playback_advance_callback(&mut self) {}
    fn set_engine_error_callback(&mut self) {}
    fn is_initialized(&self) -> bool {
        self.initialized
    }
    fn playing_cue_ids(&self) -> Vec<String> {
        self.playing.keys().cloned().collect()
    }
    fn is_playing(&self, cue_id: &str) -> bool {
        self.playing.contains_key(cue_id)
    }
    fn apply_audio_config(&mut self, config: &Value) -> Value {
        let spec = config
            .get("audioOutputDeviceId")
            .cloned()
            .unwrap_or(Value::Null);
        let next_device = self.registry.resolve(&spec);
        let next_channels =
            self.resolve_channels(config.get("audioOutputChannelCount"), &next_device);
        let next_rate = jsv::or(
            config.get("audioSampleRate"),
            jsv::or(Some(&self.sample_rate), json!(48000)),
        );
        let next_buffer = jsv::or(
            config.get("audioBufferSize"),
            jsv::or(Some(&self.buffer_size), json!(512)),
        );
        let unchanged = self.initialized
            && strict_eq(Some(&self.device_id), Some(&next_device))
            && strict_eq(Some(&self.channel_count), Some(&next_channels))
            && strict_eq(Some(&self.sample_rate), Some(&next_rate))
            && strict_eq(Some(&self.buffer_size), Some(&next_buffer));
        if unchanged {
            return json!({ "success": true, "unchanged": true });
        }
        self.stop_all_cues(false, None);
        let mut merged = config.as_object().cloned().unwrap_or_default();
        merged.insert("audioOutputChannelCount".into(), next_channels);
        merged.insert("audioSampleRate".into(), next_rate);
        merged.insert("audioBufferSize".into(), next_buffer);
        let cache = coalesce(
            config.get("pcmCacheDir"),
            self.pcm_cache_dir
                .clone()
                .map_or(Value::Null, Value::String),
        );
        merged.insert("pcmCacheDir".into(), cache);
        self.apply_values(&Value::Object(merged));
        // The decoded buffers are at the old rate.
        match self.open() {
            Ok(()) => {
                // A reopen that failed earlier marked the engine unusable; this one worked (WO-017).
                self.initialized = true;
                json!({ "success": true, "unchanged": false })
            }
            Err(e) => {
                self.initialized = false;
                self.init_error = Some(e.clone());
                json!({ "success": false, "error": e })
            }
        }
    }
    fn play_cue(&mut self, cue_id: &str, file_path: &Value, options: &Value) -> Value {
        if !self.initialized || self.state.is_none() {
            let error = self
                .init_error
                .clone()
                .unwrap_or_else(|| "Audio engine not initialized".into());
            return json!({ "success": false, "error": error });
        }
        match self.do_play(cue_id, file_path, options) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("AudioPlaybackManager: Error playing cue {cue_id}: {e}");
                json!({ "success": false, "error": e })
            }
        }
    }
    fn stop_cue(&mut self, cue_id: &str, fade_out: bool, seconds: f64) -> Value {
        self.stop_cue_impl(cue_id, fade_out, Some(seconds))
    }
    fn stop_all_cues(&mut self, fade_out: bool, seconds: Option<f64>) -> Value {
        let ids: Vec<String> = self.playing.keys().cloned().collect();
        let mut results = Vec::new();
        for id in ids {
            let r = self.stop_cue_impl(&id, fade_out, seconds);
            let mut o = Obj::new();
            o.insert("cueId".into(), json!(id));
            if let Value::Object(m) = r {
                o.extend(m);
            }
            results.push(Value::Object(o));
        }
        json!({ "success": true, "results": results })
    }
    fn pause_cue(&mut self, cue_id: &str) -> Value {
        let ok = self.playing.get(cue_id).is_some_and(|i| !i.is_paused) && self.state.is_some();
        if !ok {
            return json!({ "success": false, "error": "Cue not playing" });
        }
        match self.cues.get_mut(cue_id) {
            Some(c) if !c.paused => c.paused = true,
            _ => return json!({ "success": false, "error": "Cue not playing" }),
        }
        self.post(Cmd::Pause(Arc::from(cue_id)));
        if let Some(i) = self.playing.get_mut(cue_id) {
            i.is_paused = true;
        }
        json!({ "success": true, "status": "paused" })
    }
    fn resume_cue(&mut self, cue_id: &str) -> Value {
        let ok = self.playing.get(cue_id).is_some_and(|i| i.is_paused) && self.state.is_some();
        if !ok {
            return json!({ "success": false, "error": "Cue not paused" });
        }
        match self.cues.get_mut(cue_id) {
            Some(c) if c.paused => c.paused = false,
            _ => return json!({ "success": false, "error": "Cue not paused" }),
        }
        self.post(Cmd::Resume(Arc::from(cue_id)));
        if let Some(i) = self.playing.get_mut(cue_id) {
            i.is_paused = false;
        }
        json!({ "success": true, "status": "playing" })
    }
    fn set_cue_volume(&mut self, cue_id: &str, volume: &Value) {
        if let Some(i) = self.playing.get_mut(cue_id) {
            i.volume = volume.clone();
        }
        if self.cues.contains_key(cue_id) {
            self.post(Cmd::SetGain(
                Arc::from(cue_id),
                jsv::to_number(volume),
                0.05,
            ));
        }
    }
    fn set_cue_duck(&mut self, cue_id: &str, multiplier: f64, seconds: f64) {
        if self.cues.contains_key(cue_id) {
            self.post(Cmd::SetDuck(Arc::from(cue_id), multiplier, seconds));
        }
    }
    fn set_master_volume(&mut self, volume: f64) {
        // `Math.max(0, Math.min(2, Number(volume)))`, then WorkerMixer's `Number(value) || 0`.
        self.master = js_max(0.0, js_min(2.0, volume));
        self.mixer_master = if self.master.is_nan() {
            0.0
        } else {
            self.master
        }
        .clamp(0.0, 2.0);
        let m = self.mixer_master;
        self.post(Cmd::Master(m));
    }
    fn master_volume(&self) -> f64 {
        self.master
    }
    fn voice_count(&self, cue_id: &str) -> usize {
        self.cues.get(cue_id).map_or(0, |c| c.voices)
    }
    fn clear_next(&mut self, cue_id: &str) {
        if self.queued_next.remove(cue_id).is_some() && self.cues.contains_key(cue_id) {
            self.post(Cmd::ClearNext(Arc::from(cue_id)));
        }
    }
    fn queue_next(
        &mut self,
        cue_id: &str,
        file_path: &Value,
        options: &Value,
        still_wanted: &mut dyn FnMut() -> bool,
    ) -> bool {
        if self.state.is_none() || !self.playing.contains_key(cue_id) {
            return false;
        }
        // Decode first, then ask whether the item is still wanted (the original awaits the load).
        let path = file_path.as_str().unwrap_or_default().to_string();
        let loaded = match self.load(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("AudioPlaybackManager: Could not load the next item of {cue_id}: {e}");
                return false;
            }
        };
        self.sync();
        if !self.playing.contains_key(cue_id) || !still_wanted() {
            return false;
        }
        let trim_start = coalesce(options.get("trimStartTime"), json!(0));
        let trim_end = coalesce(options.get("trimEndTime"), jsv::num(loaded.duration_sec));
        let token = options.get("token").cloned().unwrap_or_else(js::undefined);
        self.queued_next.insert(
            cue_id.to_string(),
            QueuedNext {
                file_path: file_path.clone(),
                trim_start_time: trim_start.clone(),
                trim_end_time: trim_end.clone(),
                token: token.clone(),
            },
        );
        if !self.cues.contains_key(cue_id) {
            return false;
        }
        let opts = PlayOptions {
            channels: Some(loaded.channels as f64),
            sample_rate: Some(f64::from(loaded.sample_rate)),
            trim_start_time: Some(n(Some(&trim_start))),
            trim_end_time: Some(n(Some(&trim_end))),
            token: Some(token),
            ..PlayOptions::default()
        };
        self.post(Cmd::QueueNext {
            cue: Arc::from(cue_id),
            buffer: loaded.buffer,
            opts: Box::new(opts),
        });
        true
    }
    fn forget_buffer(&mut self, path: &Value) {
        if let Some(p) = path.as_str() {
            self.buffers.delete(&p.to_string());
        }
    }
    fn voices(&self) -> Vec<Value> {
        let report = self.settled_report();
        let mut out = Vec::new();
        for (v, seq) in &report.voices {
            let Some(cue) = self.cues.get(&*v.cue_id) else {
                continue;
            };
            if *seq != Some(cue.seq) {
                continue;
            }
            out.push(json!({
                "cueId": &*v.cue_id, "voiceId": &*v.voice_id, "isPaused": cue.paused,
                "stopping": v.stopping, "isFadingOut": v.is_fading_out, "isFadingIn": v.is_fading_in,
                "fadeRemainingSec": js::number(v.fade_remaining_sec), "isDucked": v.is_ducked,
                "duckGain": js::number(v.duck_gain), "positionSec": js::number(v.position_sec),
                "trimStartSec": js::number(v.trim_start_sec), "trimEndSec": js::number(v.trim_end_sec),
                "volume": js::number(v.volume), "currentGain": js::number(v.current_gain),
                "outputPatch": [js::number(v.output_patch[0]), js::number(v.output_patch[1])],
            }));
        }
        out
    }
    fn drain_peak_levels(&mut self) -> Obj {
        self.sync();
        let mut levels = Obj::new();
        for (cue, track) in &self.cues {
            let level = if track.paused {
                0.0
            } else {
                self.peaks.get(cue).copied().unwrap_or(0.0)
            };
            levels.insert(cue.clone(), jsv::num(level));
        }
        self.peaks.clear();
        levels
    }
    fn device_id(&self) -> Value {
        self.device_id.clone()
    }
    fn sample_rate(&self) -> Value {
        self.sample_rate.clone()
    }
    fn channel_count(&self) -> Value {
        self.channel_count.clone()
    }
    fn cleanup(&mut self) {
        self.stop_all_cues(false, None);
        self.buffers.clear();
        self.close();
        self.state = None;
        self.cmd_tx = None;
        self.event_rx = None;
        self.cues.clear();
        self.initialized = false;
        eprintln!("AudioPlaybackManager: Cleanup completed");
    }
    fn take_events(&mut self) -> Vec<EngineEvent> {
        self.sync();
        std::mem::take(&mut self.pending)
    }
    fn output_devices(&mut self) -> Value {
        Value::Array(
            self.registry
                .devices()
                .iter()
                .filter(|d| d.output_channels > 0)
                .map(DeviceInfo::to_json)
                .collect(),
        )
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WO-024: a stream that still counts as running but whose callback no longer runs (killed,
    /// the error not yet reported): the status must still include every command sent.
    #[test]
    fn settled_report_applies_commands_a_stalled_stream_never_took() {
        let mut engine = CpalEngine::new();
        engine.ensure_mixer();
        engine.stream_open = true;
        engine.alive.store(true, Ordering::SeqCst);
        engine.period_sec = 0.01;
        engine.post(Cmd::Master(0.5));
        engine.post(Cmd::Master(0.25));
        let applied = engine.settled_report().applied;
        assert_eq!(applied, engine.posted, "commands the status reflects");
    }

    /// WO-028: cpal reports an overload (a dropout) through the error callback; the stream runs on.
    #[test]
    fn an_overload_leaves_the_stream_running() {
        let alive = AtomicBool::new(true);
        let errors = Mutex::new(Vec::new());
        let dropouts = Dropouts::default();
        stream_error(&cpal::ErrorKind::Xrun.into(), &alive, &errors, &dropouts);
        assert!(alive.load(Ordering::SeqCst), "stream still counted running");
        assert!(errors.lock().unwrap().is_empty(), "no engine error");
        assert_eq!(
            dropouts.underflows.load(Ordering::Relaxed),
            1,
            "counted as an underflow"
        );
        // A real failure still stops it.
        stream_error(
            &cpal::ErrorKind::StreamInvalidated.into(),
            &alive,
            &errors,
            &dropouts,
        );
        assert!(!alive.load(Ordering::SeqCst));
        assert_eq!(errors.lock().unwrap().len(), 1);
    }

    /// WO-029: a callback more than two periods after the previous one is a late buffer, and
    /// the counts come out as the worker's log line, then reset.
    #[test]
    fn a_late_callback_is_reported_as_a_dropout() {
        let dropouts = Dropouts::default();
        let mut clock = CallbackClock::default();
        let period = Duration::from_millis(10);
        let t0 = Instant::now();
        clock.tick(t0, period, &dropouts);
        clock.tick(t0 + Duration::from_millis(15), period, &dropouts);
        assert_eq!(
            dropouts.take_report(DROPOUT_REPORT_INTERVAL),
            None,
            "on time: nothing"
        );
        clock.tick(t0 + Duration::from_millis(50), period, &dropouts);
        dropouts.underflows.fetch_add(2, Ordering::Relaxed);
        assert_eq!(
            dropouts.take_report(DROPOUT_REPORT_INTERVAL).as_deref(),
            Some(
                "WorkerMixer: Audio dropouts in the last 5s: 2 underflow(s) reported by the \
                 driver, 1 late buffer(s) (worst gap 35.0 ms, buffer period 10.0 ms)"
            )
        );
        assert_eq!(dropouts.take_report(DROPOUT_REPORT_INTERVAL), None, "reset");
    }
}
