//! `audioDecoder.js`: any audio file to interleaved stereo f32 at the engine rate.
//!
//! The original runs ffmpeg for everything. Here (rust/DECISIONS.md ADR-007, ADR-018) symphonia
//! decodes WAV, AIFF, FLAC, Ogg Vorbis and MP3 (with the LAME gapless trim, as ffmpeg does) and
//! rubato resamples when the file's rate isn't the engine's. Everything else goes to the same
//! ffmpeg command as the original, so it comes out exactly as today:
//! - AAC/M4A/MP4 (encoder delay and padding, HE-AAC, multichannel: ffmpeg's handling),
//! - more than 2 channels (`-ac 2`'s downmix: centre and surrounds at -3 dB, LFE dropped),
//! - a file whose channel count music-metadata doesn't report as 1 or 2 matching what is decoded
//!   (the original decides "mono" from the tags; `-ac 2` puts an untagged mono file at -3 dB),
//! - MP3s without a Xing/Info/VBRI header (symphonia estimates their length and cut a VBR file
//!   short; ffmpeg reads to the end),
//! - WAV/AIFF files with an odd-sized chunk (the pad byte; symphonia misread it),
//! - anything symphonia can't open or decode (Ogg Opus, ...).
//!
//! Output is always 2 channels (rust/MAP.md: the mixer reads a 1-channel buffer's next frame as
//! its right side), mono copied to both sides at full level (WO-004).

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::core::probe;

/// `DECODER_VERSION`: bumped whenever what comes out changes, so cached PCM isn't reused.
/// 3: the Rust decoder (symphonia + rubato).
pub const DECODER_VERSION: u32 = 3;

pub const CHANNELS: usize = 2;

/// `decodeToFloat32`'s result.
#[derive(Debug, Clone)]
pub struct Decoded {
    /// Interleaved stereo.
    pub samples: Vec<f32>,
    pub channels: usize,
    pub sample_rate: u32,
    pub duration_sec: f64,
    /// Which decoder produced it (for the comparison script and logs).
    pub via: &'static str,
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

/// `decodeToFloat32(filePath, sampleRate)`.
pub fn decode_to_float32(file_path: &str, sample_rate: u32) -> Result<Decoded, String> {
    if !Path::new(file_path).exists() {
        return Err(format!("Audio file not found: {file_path}"));
    }
    // `sourceChannelCount`: what music-metadata says, or null.
    let tagged_channels = probe::parse_file(file_path, false)
        .ok()
        .and_then(|p| p.channels)
        .filter(|c| *c > 0.0);
    if let Some(decoded) = symphonia_decode(file_path, sample_rate, tagged_channels) {
        return Ok(decoded);
    }
    ffmpeg_decode(file_path, sample_rate, tagged_channels == Some(1.0))
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// The symphonia route, or `None` to hand the file to ffmpeg.
fn symphonia_decode(path: &str, rate: u32, tagged: Option<f64>) -> Option<Decoded> {
    let ext = ext_of(path);
    if matches!(ext.as_str(), "m4a" | "aac" | "mp4" | "m4b" | "3gp") {
        return None;
    }
    let head = std::fs::read(path).ok()?;
    if head.starts_with(b"RIFF") || head.starts_with(b"FORM") {
        if riff_has_odd_chunk(&head) {
            return None;
        }
    } else if (ext == "mp3" || head.starts_with(b"ID3")) && !mp3_has_info_header(&head) {
        return None;
    }
    drop(head);
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = format.default_track(TrackType::Audio)?;
    let params = track.codec_params.as_ref()?.audio()?.clone();
    let track_id = track.id;
    let src_rate = params.sample_rate?;
    let src_channels = params.channels.as_ref()?.count();
    // Only where the original's choice (from the tags) is the plain one: mono copied (tagged 1)
    // or stereo as it is (tagged 2). Anything else: ffmpeg, to keep its exact behavior.
    match (src_channels, tagged) {
        (1, Some(1.0)) | (2, Some(2.0)) => {}
        _ => return None,
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .ok()?;
    let mut pcm: Vec<f32> = Vec::new();
    let mut chunk: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => return None,
            Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                if buf.spec().channels().count() != src_channels {
                    return None;
                }
                buf.copy_to_vec_interleaved(&mut chunk);
                pcm.extend_from_slice(&chunk);
            }
            Err(SymError::DecodeError(_)) => {}
            Err(_) => return None,
        }
    }
    if pcm.is_empty() {
        return None;
    }
    let stereo = if src_channels == 1 {
        pcm.iter().flat_map(|&s| [s, s]).collect()
    } else {
        pcm
    };
    let samples = if src_rate == rate {
        stereo
    } else {
        resample(&stereo, src_rate, rate)?
    };
    let frames = samples.len() / CHANNELS;
    Some(Decoded {
        samples,
        channels: CHANNELS,
        sample_rate: rate,
        duration_sec: frames as f64 / f64::from(rate),
        via: "symphonia",
    })
}

/// Whether a RIFF (WAV) or FORM (AIFF) file has a chunk of odd size before its end.
fn riff_has_odd_chunk(b: &[u8]) -> bool {
    let le = b.starts_with(b"RIFF");
    let mut o = 12;
    while o + 8 <= b.len() {
        let raw = [b[o + 4], b[o + 5], b[o + 6], b[o + 7]];
        let size = if le {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        } as usize;
        if size % 2 == 1 {
            return true;
        }
        o = o.saturating_add(8).saturating_add(size);
    }
    false
}

/// Whether an MP3 has a Xing, Info or VBRI header in its first frame (after any ID3v2 tag).
fn mp3_has_info_header(b: &[u8]) -> bool {
    let mut start = 0;
    if b.starts_with(b"ID3") && b.len() >= 10 {
        let size = (usize::from(b[6] & 0x7f) << 21)
            | (usize::from(b[7] & 0x7f) << 14)
            | (usize::from(b[8] & 0x7f) << 7)
            | usize::from(b[9] & 0x7f);
        start = 10 + size + if b[5] & 0x10 != 0 { 10 } else { 0 };
    }
    let Some(frame) = b.get(start..) else {
        return false;
    };
    let Some(sync) = frame
        .windows(2)
        .position(|w| w[0] == 0xff && w[1] & 0xe0 == 0xe0)
    else {
        return false;
    };
    let first = &frame[sync..frame.len().min(sync + 200)];
    first
        .windows(4)
        .any(|w| w == b"Xing" || w == b"Info" || w == b"VBRI")
}

/// Whole-clip stereo resampling with rubato's FFT resampler (ADR-018); `process_all` trims the
/// resampler's delay, so the output lines up with the input and has `ceil(ratio * frames)` frames.
pub fn resample(stereo: &[f32], from: u32, to: u32) -> Option<Vec<f32>> {
    let frames = stereo.len() / CHANNELS;
    let mut resampler =
        Fft::<f32>::new(from as usize, to as usize, 1024, CHANNELS, FixedSync::Both).ok()?;
    let input = InterleavedSlice::new(stereo, CHANNELS, frames).ok()?;
    let out = resampler.process_all(&input, frames, None).ok()?;
    // swresample's length: ceil(frames * to / from) in integers (the float ratio overshoots by one
    // frame when the result is whole, e.g. 441000 at 44.1 -> 48 kHz).
    let want = (frames as u64 * u64::from(to)).div_ceil(u64::from(from)) as usize;
    let mut data = out.take_data();
    data.truncate(want * CHANNELS);
    Some(data)
}

/// The ffmpeg binary: `FFMPEG_PATH`, the one shipped with the app, `vendor/ffmpeg/`, then `PATH`
/// (`ffmpegBinary()`).
pub fn ffmpeg_binary() -> String {
    if let Some(p) = std::env::var_os("FFMPEG_PATH") {
        return p.to_string_lossy().into_owned();
    }
    let exe = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let mut candidates = Vec::new();
    if let Ok(me) = std::env::current_exe()
        && let Some(dir) = me.parent()
    {
        // Next to the packaged binary (installers put ffmpeg in a sibling `ffmpeg/` folder).
        candidates.push(dir.join("ffmpeg").join(exe));
        candidates.push(dir.join("..").join("ffmpeg").join(exe));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let vendor = root.join("vendor").join("ffmpeg");
    candidates.push(vendor.join(format!("{platform}-universal")).join(exe));
    candidates.push(vendor.join(format!("{platform}-{arch}")).join(exe));
    candidates.into_iter().find(|c| c.exists()).map_or_else(
        || "ffmpeg".to_string(),
        |c| c.to_string_lossy().into_owned(),
    )
}

/// The original's command, unchanged.
fn ffmpeg_decode(path: &str, rate: u32, mono: bool) -> Result<Decoded, String> {
    let name = basename(path);
    let mut args: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path,
        "-vn",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if mono {
        args.extend(["-af".into(), "pan=stereo|c0=c0|c1=c0".into()]);
    } else {
        args.extend(["-ac".into(), CHANNELS.to_string()]);
    }
    args.extend(["-ar".into(), rate.to_string(), "pipe:1".into()]);
    let mut cmd = Command::new(ffmpeg_binary());
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows: a server started without a console (by the tray) would otherwise open a console
    // window for every ffmpeg it runs (WO-053).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
        let hint = if e.kind() == std::io::ErrorKind::NotFound {
            " (ffmpeg not found - install it, or set FFMPEG_PATH)"
        } else {
            ""
        };
        format!("ffmpeg decode failed for {name}: {e}{hint}")
    })?;
    let mut stderr_pipe = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = stderr_pipe.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let mut bytes = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        out.read_to_end(&mut bytes)
            .map_err(|e| format!("ffmpeg decode failed for {name}: {e}"))?;
    }
    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg decode failed for {name}: {e}"))?;
    let stderr = err_thread.join().unwrap_or_default();
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            format!("exit code {}", status.code().unwrap_or(-1))
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("ffmpeg decode failed for {name}: {detail}"));
    }
    if bytes.is_empty() {
        return Err(format!("ffmpeg produced no audio data for {name}"));
    }
    let samples: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    let frames = samples.len() / CHANNELS;
    Ok(Decoded {
        samples,
        channels: CHANNELS,
        sample_rate: rate,
        duration_sec: frames as f64 / f64::from(rate),
        via: "ffmpeg",
    })
}
