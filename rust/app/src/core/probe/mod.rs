//! Audio metadata as `music-metadata` 11.16.1 reports it (`parseFile(path, { duration })`): the
//! fields the library records keep (`duration`, `bitrate`, `sampleRate`, `numberOfChannels`,
//! `common.title/artist/album`), computed by the same rules so stored values match exactly
//! (research/files-and-metadata.md 2.4).
//!
//! Parsers: MPEG (MP3, ADTS AAC), WAVE, FLAC, Ogg Vorbis, MP4/M4A; tags from ID3v2.2-2.4, ID3v1,
//! RIFF INFO, Vorbis comments and iTunes atoms, ranked as music-metadata ranks them.
//! Not ported (the probe fails or leaves a field out where music-metadata would report it):
//! APEv2 and Lyrics3 tags, Ogg Opus/FLAC/Speex, fragmented MP4, content sniffing of files whose
//! extension names no parser.

mod flac;
mod mp4;
mod mpeg;
mod ogg;
mod tags;
mod wav;

use std::collections::HashMap;

pub use tags::Collector;

/// What a probe found: the `format` and `common` fields the library uses.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Probe {
    pub duration: Option<f64>,
    pub bitrate: Option<f64>,
    pub sample_rate: Option<f64>,
    pub channels: Option<f64>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// Why reading stopped.
#[derive(Debug, Clone)]
pub enum PErr {
    /// strtok3's `EndOfStreamError`.
    Eof,
    /// Any other error: the message music-metadata throws.
    Msg(String),
}

pub type PResult<T> = Result<T, PErr>;

pub fn msg<T>(m: impl Into<String>) -> PResult<T> {
    Err(PErr::Msg(m.into()))
}

/// strtok3's file tokenizer over the whole file.
pub struct Tok<'a> {
    pub buf: &'a [u8],
    pub pos: usize,
}

impl<'a> Tok<'a> {
    pub fn size(&self) -> usize {
        self.buf.len()
    }

    /// `readBuffer`/`readToken`: on a short read the position still advances, then EOF.
    pub fn read(&mut self, n: usize) -> PResult<&'a [u8]> {
        let start = self.pos.min(self.buf.len());
        let end = start.saturating_add(n).min(self.buf.len());
        self.pos = end;
        if end - start < n {
            return Err(PErr::Eof);
        }
        Ok(&self.buf[start..end])
    }

    pub fn read_at(&mut self, at: usize, n: usize) -> PResult<&'a [u8]> {
        self.pos = at;
        self.read(n)
    }

    /// `peekBuffer`/`peekToken` without `mayBeLess`.
    pub fn peek(&self, n: usize) -> PResult<&'a [u8]> {
        let start = self.pos.min(self.buf.len());
        let end = start.saturating_add(n).min(self.buf.len());
        if end - start < n {
            return Err(PErr::Eof);
        }
        Ok(&self.buf[start..end])
    }

    /// `peekBuffer(..., { mayBeLess: true })`.
    pub fn peek_less(&self, n: usize) -> &'a [u8] {
        let start = self.pos.min(self.buf.len());
        let end = start.saturating_add(n).min(self.buf.len());
        &self.buf[start..end]
    }

    /// `ignore(n)`: clamped to the end of the file.
    pub fn ignore(&mut self, n: usize) {
        self.pos = self.pos.saturating_add(n).min(self.buf.len().max(self.pos));
    }
}

pub fn u16be(b: &[u8], o: usize) -> u32 {
    (u32::from(b[o]) << 8) | u32::from(b[o + 1])
}
pub fn u32be(b: &[u8], o: usize) -> u32 {
    u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
pub fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
pub fn u16le(b: &[u8], o: usize) -> u32 {
    u32::from(b[o]) | (u32::from(b[o + 1]) << 8)
}
pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

/// The parser music-metadata picks for a path (`findLoaderForExtension`).
fn loader(path: &str) -> Option<&'static str> {
    let ext = super::nodefs::extname(path).to_lowercase();
    match ext.as_str() {
        ".mp1" | ".mp2" | ".mp3" | ".m2a" | ".aac" => Some("mpeg"),
        ".mp4" | ".m4a" | ".m4b" | ".m4pa" | ".mov" | ".movie" | ".qt" => Some("mp4"),
        ".wav" | ".bwf" => Some("wav"),
        ".flac" => Some("flac"),
        ".ogg" | ".ogv" | ".oga" | ".ogm" | ".ogx" | ".opus" | ".spx" => Some("ogg"),
        _ => None,
    }
}

/// `file-type`'s detection, for the containers the library takes, when the path names no parser:
/// ID3, MPEG/ADTS frame sync within the first 10 bytes, `fLaC`, `OggS`, RIFF/WAVE, `ftyp`.
fn sniff(b: &[u8]) -> Option<&'static str> {
    let at = |o: usize, sig: &[u8]| b.len() >= o + sig.len() && &b[o..o + sig.len()] == sig;
    if at(0, b"ID3") {
        return Some("mpeg");
    }
    if at(0, b"fLaC") {
        return Some("flac");
    }
    if at(0, b"OggS") {
        return Some("ogg");
    }
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Some("wav");
    }
    if at(4, b"ftyp") {
        return Some("mp4");
    }
    (0..=10)
        .find(|&i| b.len() >= i + 2 && b[i] == 0xff && (b[i + 1] & 0xe0) == 0xe0)
        .map(|_| "mpeg")
}

/// `musicMetadata.parseFile(path, { duration })`: `Err` carries the error message.
pub fn parse_file(path: &str, duration: bool) -> Result<Probe, String> {
    let bytes = std::fs::read(path).map_err(|e| super::nodefs::err(&e, "open", path).message)?;
    parse_bytes(&bytes, path, duration)
}

pub fn parse_bytes(bytes: &[u8], path: &str, duration: bool) -> Result<Probe, String> {
    let Some(kind) = loader(path).or_else(|| sniff(bytes)) else {
        return Err(format!("Failed to determine audio format: {path}"));
    };
    let mut c = Collector::default();
    let mut t = Tok { buf: bytes, pos: 0 };
    let ape = tags::scan_appending_headers(&t);
    let result = match kind {
        "mpeg" => mpeg::parse(&mut t, &mut c, duration, ape),
        "flac" => flac::parse(&mut t, &mut c, ape),
        "wav" => wav::parse(&mut t, &mut c),
        "ogg" => ogg::parse(&mut t, &mut c, duration),
        _ => mp4::parse(&mut t, &mut c),
    };
    match result {
        Ok(()) => Ok(c.into_probe()),
        Err(PErr::Eof) => Err("End-Of-Stream".into()),
        Err(PErr::Msg(m)) => Err(m),
    }
}

/// Values found per format field, for parsers that set and reset them.
#[derive(Debug, Default, Clone)]
pub struct Format {
    pub values: HashMap<&'static str, f64>,
    pub codec_profile: Option<String>,
}

impl Format {
    pub fn set(&mut self, k: &'static str, v: f64) {
        self.values.insert(k, v);
    }
    pub fn get(&self, k: &str) -> Option<f64> {
        self.values.get(k).copied()
    }
    pub fn unset(&mut self, k: &str) {
        self.values.remove(k);
    }
}
