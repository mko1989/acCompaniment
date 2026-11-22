//! `MetadataCollector`'s common tags (title, artist, artists, album), ID3v2 and ID3v1.

use std::collections::HashMap;

use super::{Format, PErr, PResult, Probe, Tok, latin1, u32be};

/// The collected `format` and `common` fields.
#[derive(Debug, Default)]
pub struct Collector {
    pub format: Format,
    title: Option<String>,
    album: Option<String>,
    artist: Option<String>,
    artists: Option<Vec<String>>,
    origin: HashMap<&'static str, u32>,
    pub id3v1_native: bool,
}

fn priority(tag_type: &str) -> u32 {
    match tag_type {
        "matroska" => 1,
        "APEv2" => 2,
        "vorbis" => 3,
        "ID3v2.4" => 4,
        "ID3v2.3" => 5,
        "ID3v2.2" => 6,
        "exif" => 7,
        "asf" => 8,
        "iTunes" => 9,
        "AIFF" => 10,
        "ID3v1" => 11,
        "artificial" => 500,
        _ => 1000,
    }
}

/// The common field a native tag maps to, per tag type.
fn common_id(tag_type: &str, id: &str) -> Option<&'static str> {
    let m = match tag_type {
        "vorbis" => match id {
            "TITLE" => "title",
            "ARTIST" => "artist",
            "ARTISTS" => "artists",
            "ALBUM" => "album",
            _ => return None,
        },
        "ID3v2.3" | "ID3v2.4" => match id {
            "TIT2" => "title",
            "TPE1" => "artist",
            "TALB" => "album",
            _ => return None,
        },
        "ID3v2.2" => match id {
            "TT2" => "title",
            "TP1" => "artist",
            "TAL" => "album",
            _ => return None,
        },
        "exif" => match id {
            "INAM" => "title",
            "IART" => "artist",
            "IPRD" => "album",
            _ => return None,
        },
        "iTunes" => match id {
            "©nam" => "title",
            "©ART" => "artist",
            "©alb" => "album",
            "----:com.apple.iTunes:ARTISTS" => "artists",
            _ => return None,
        },
        "ID3v1" => match id {
            "title" => "title",
            "artist" => "artist",
            "album" => "album",
            _ => return None,
        },
        _ => return None,
    };
    Some(m)
}

fn join_artists(a: &[String]) -> String {
    if a.len() > 2 {
        format!("{} & {}", a[..a.len() - 1].join(", "), a[a.len() - 1])
    } else {
        a.join(" & ")
    }
}

impl Collector {
    /// `addTag(tagType, tagId, value)`.
    pub fn add_tag(&mut self, tag_type: &'static str, id: &str, value: String) {
        if tag_type == "ID3v1" {
            self.id3v1_native = true;
        }
        if let Some(common) = common_id(tag_type, id) {
            self.post_map(tag_type, common, value);
        }
    }

    fn post_map(&mut self, tag_type: &'static str, id: &'static str, value: String) {
        match id {
            "artist" => {
                if self.origin.get("artist") == Some(&priority(tag_type)) {
                    return self.post_map("artificial", "artists", value);
                }
                if self.artists.is_none() {
                    self.set_generic("artificial", "artists", value.clone());
                }
                self.set_generic(tag_type, "artist", value);
            }
            "artists" => {
                if self.artist.is_none()
                    || self.origin.get("artist") == Some(&priority("artificial"))
                {
                    let known = self.artists.as_ref().is_some_and(|a| a.contains(&value));
                    if !known {
                        let mut values = self.artists.clone().unwrap_or_default();
                        values.push(value.clone());
                        self.set_generic("artificial", "artist", join_artists(&values));
                    }
                }
                self.set_generic(tag_type, "artists", value);
            }
            _ => self.set_generic(tag_type, id, value),
        }
    }

    fn set_generic(&mut self, tag_type: &'static str, id: &'static str, value: String) {
        let prio0 = self.origin.get(id).copied().unwrap_or(1000);
        let prio1 = priority(tag_type);
        if id == "artists" {
            if prio1 == prio0 {
                let list = self.artists.get_or_insert_with(Vec::new);
                if !list.contains(&value) {
                    list.push(value);
                }
            } else if prio1 < prio0 {
                self.artists = Some(vec![value]);
                self.origin.insert(id, prio1);
            }
            return;
        }
        if prio1 <= prio0 {
            match id {
                "title" => self.title = Some(value),
                "album" => self.album = Some(value),
                "artist" => self.artist = Some(value),
                _ => return,
            }
            self.origin.insert(id, prio1);
        }
    }

    pub fn into_probe(self) -> Probe {
        Probe {
            duration: self.format.get("duration"),
            bitrate: self.format.get("bitrate"),
            sample_rate: self.format.get("sampleRate"),
            channels: self.format.get("numberOfChannels"),
            title: self.title,
            artist: self.artist,
            album: self.album,
        }
    }
}

/// `scanAppendingHeaders`: whether an APEv2 footer sits at the end. APE tags themselves are not
/// read (see the module docs); the probe only needs to know the layout.
pub fn scan_appending_headers(t: &Tok) -> bool {
    let size = t.size();
    let mut ape_offset = size;
    if size >= 128 && &t.buf[size - 128..size - 125] == b"TAG" {
        ape_offset -= 128;
    }
    ape_offset > 32 && &t.buf[ape_offset - 32..ape_offset - 24] == b"APETAGEX"
}

fn syncsafe(b: &[u8], o: usize) -> usize {
    (usize::from(b[o] & 0x7f) << 21)
        | (usize::from(b[o + 1] & 0x7f) << 14)
        | (usize::from(b[o + 2] & 0x7f) << 7)
        | usize::from(b[o + 3] & 0x7f)
}

/// `AbstractID3Parser.tryReadId3v2Headers`: every ID3v2 tag at the current position.
pub fn try_read_id3v2_headers(t: &mut Tok, c: &mut Collector) -> PResult<()> {
    loop {
        let head = t.peek(10)?;
        if &head[0..3] != b"ID3" {
            return Ok(());
        }
        parse_id3v2(t, c)?;
    }
}

/// `ID3v2Parser.parse` at the current position.
pub fn parse_id3v2(t: &mut Tok, c: &mut Collector) -> PResult<()> {
    let h = t.read(10)?;
    if &h[0..3] != b"ID3" {
        return Err(PErr::Msg(
            "expected ID3-header file-identifier 'ID3' was not found".into(),
        ));
    }
    let major = h[3];
    let flags = h[5];
    let size = syncsafe(h, 6);
    let remaining = t.size().saturating_sub(t.pos);
    if size > remaining {
        return Err(PErr::Msg(format!(
            "ID3v2 tag size {size} exceeds remaining file size {remaining}"
        )));
    }
    let tag_type: &'static str = match major {
        2 => "ID3v2.2",
        3 => "ID3v2.3",
        4 => "ID3v2.4",
        _ => "ID3v2.x",
    };
    let data_len = if flags & 0x40 != 0 {
        let ext = t.read(10)?;
        let ext_size = u32be(ext, 0) as usize;
        if ext_size > 10 {
            t.ignore(ext_size - 10);
        }
        size.saturating_sub(ext_size)
    } else {
        size
    };
    let data = t.read(data_len)?;
    parse_frames(data, major, tag_type, c)
}

fn parse_frames(data: &[u8], major: u8, tag_type: &'static str, c: &mut Collector) -> PResult<()> {
    let header_len = match major {
        2 => 6,
        3 | 4 => 10,
        _ => return Err(PErr::Msg(format!("Unexpected majorVer: {major}"))),
    };
    let mut off = 0;
    while off != data.len() {
        if off + header_len > data.len() {
            break;
        }
        let fh = &data[off..off + header_len];
        off += header_len;
        let (id, len, unsync, dli) = if major == 2 {
            (
                latin1(&fh[0..3]),
                (usize::from(fh[3]) << 16) | (usize::from(fh[4]) << 8) | usize::from(fh[5]),
                false,
                false,
            )
        } else {
            let len = if major == 4 {
                syncsafe(fh, 4)
            } else {
                u32be(fh, 4) as usize
            };
            let fmt = fh[9];
            let (u, d) = if major == 4 {
                (fmt & 0x02 != 0, fmt & 0x01 != 0)
            } else {
                (false, false)
            };
            (latin1(&fh[0..4]), len, u, d)
        };
        let end = off.saturating_add(len).min(data.len());
        let mut frame: Vec<u8> = data[off.min(data.len())..end].to_vec();
        off = off.saturating_add(len);
        if unsync {
            frame = remove_unsync(&frame);
        }
        if dli {
            frame = frame.get(4..).map(<[u8]>::to_vec).unwrap_or_default();
        }
        for value in read_text_frame(&frame, &id, major) {
            c.add_tag(tag_type, &id, value);
        }
        if off > data.len() {
            break;
        }
    }
    Ok(())
}

fn remove_unsync(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i + 1 < b.len() {
        out.push(b[i]);
        i += if b[i] == 0xff && b[i + 1] == 0 { 2 } else { 1 };
    }
    if i < b.len() {
        out.push(b[i]);
    }
    out
}

fn decode_utf16(b: &[u8], little: bool) -> String {
    let units: Vec<u16> = b
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| {
            if little {
                u16::from_le_bytes(*p)
            } else {
                u16::from_be_bytes(*p)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// `util.decodeString(bytes, encoding)` for the four ID3v2 encodings.
fn decode_string(b: &[u8], enc: u8) -> String {
    if b.len() >= 2 && b[0] == 0xff && b[1] == 0xfe {
        return decode_string(&b[2..], enc);
    }
    match enc {
        1 if b.len() >= 2 && b[0] == 0xfe && b[1] == 0xff => decode_utf16(b, false),
        1 => decode_utf16(b, true),
        2 => decode_utf16(b, false),
        3 => String::from_utf8_lossy(b).into_owned(),
        _ => latin1(b),
    }
}

fn trim_null_padding(s: &str) -> &str {
    s.trim_end_matches('\0')
}

fn trim_js(s: &str) -> String {
    s.trim_matches(crate::core::jsv::is_js_space).to_string()
}

/// The values of a text frame (`T*`, not `TXXX`), as `FrameParser.readData` gives them.
fn read_text_frame(frame: &[u8], id: &str, major: u8) -> Vec<String> {
    if frame.is_empty() || !id.starts_with('T') || id == "TXXX" {
        return Vec::new();
    }
    let enc = frame[0];
    let text = decode_string(&frame[1..], enc);
    let text = trim_null_padding(&text).to_string();
    let split = |tag: &str, text: &str| -> Vec<String> {
        let values: Vec<String> = if major < 4 {
            let parts: Vec<&str> = text.split('\0').collect();
            if parts.len() > 1 {
                parts.into_iter().map(str::to_string).collect()
            } else if [
                "TPE1", "TPE2", "TPE3", "TPE4", "TCOM", "TEXT", "TOLY", "TOPE", "TP1", "TCM",
                "TXT", "TOA", "TOL", "TXXX", "TSRC", "IPLS",
            ]
            .contains(&tag)
            {
                text.split('/').map(str::to_string).collect()
            } else {
                vec![text.to_string()]
            }
        } else {
            text.split('\0').map(str::to_string).collect()
        };
        values
            .iter()
            .map(|v| trim_js(trim_null_padding(v)))
            .collect()
    };
    match id {
        "TRK" | "TRCK" | "TPOS" | "TIT1" | "TIT2" | "TIT3" => vec![text],
        "TCOM" | "TEXT" | "TOLY" | "TOPE" | "TPE1" | "TSRC" => split(id, &text),
        _ if major >= 4 => split(id, &text),
        _ => vec![text],
    }
}

/// `ID3v1Parser.parse`, run after MPEG and FLAC streams.
pub fn parse_id3v1(t: &mut Tok, c: &mut Collector) {
    let size = t.size();
    if size < 128 {
        return;
    }
    let offset = size - 128;
    if t.pos > offset {
        return;
    }
    let b = &t.buf[offset..];
    t.pos = size;
    if &b[0..3] != b"TAG" {
        return;
    }
    let field = |o: usize, n: usize| -> Option<String> {
        let s = latin1(&b[o..o + n]);
        let s = s.split('\0').next().unwrap_or("");
        let s = trim_js(s);
        (!s.is_empty()).then_some(s)
    };
    let has_track = b[125] == 0 && b[126] != 0;
    let fields = [
        ("title", field(3, 30)),
        ("artist", field(33, 30)),
        ("album", field(63, 30)),
        ("comment", field(97, if has_track { 28 } else { 30 })),
        ("track", has_track.then(|| b[126].to_string())),
        ("year", field(93, 4)),
    ];
    for (id, v) in fields {
        if let Some(v) = v {
            c.add_tag("ID3v1", id, v);
        }
    }
    if b[127] < 192 {
        c.add_tag("ID3v1", "genre", String::new());
    }
}
