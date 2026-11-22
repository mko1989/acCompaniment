//! `MpegParser` (MP3 and ADTS AAC), music-metadata 11.16.1 `lib/mpeg/MpegParser.js`.

use super::tags::{self, Collector};
use super::{PErr, PResult, Tok, latin1, u32be};
use crate::js;

const MAX_PEEK: usize = 1024;

/// `common.getBitAllignedNumber(source, byteOffset, bitOffset, len)`.
fn bits(src: &[u8], byte_offset: usize, bit_offset: usize, len: usize) -> u32 {
    let byte_off = byte_offset + bit_offset / 8;
    let bit_off = bit_offset % 8;
    let mut value = u32::from(*src.get(byte_off).unwrap_or(&0)) & (0xff >> bit_off);
    let bits_read = 8 - bit_off;
    if len < bits_read {
        value >>= 8 - bit_off - len;
    } else if len > bits_read {
        let left = len - bits_read;
        value <<= left;
        value |= bits(src, byte_offset, bit_offset + bits_read, left);
    }
    value
}

fn bit_set(src: &[u8], byte_offset: usize, bit_offset: usize) -> bool {
    bits(src, byte_offset, bit_offset, 1) == 1
}

#[derive(Clone)]
struct Header {
    version: Option<f64>,
    layer: u32,
    adts: bool,
    bitrate: Option<f64>,
    sampling_rate: Option<f64>,
    padding: bool,
    channel_mode_index: u32,
    frame_length: usize,
    codec_profile: Option<&'static str>,
    mp4_channels: Option<usize>,
    protected_by_crc: bool,
}

const LAYERS: [u32; 4] = [0, 3, 2, 1];
const MPEG4_RATES: [Option<f64>; 16] = [
    Some(96000.0),
    Some(88200.0),
    Some(64000.0),
    Some(48000.0),
    Some(44100.0),
    Some(32000.0),
    Some(24000.0),
    Some(22050.0),
    Some(16000.0),
    Some(12000.0),
    Some(11025.0),
    Some(8000.0),
    Some(7350.0),
    None,
    None,
    None,
];
const MPEG4_CHANNELS: [Option<usize>; 8] = [
    None,
    Some(1),
    Some(2),
    Some(3),
    Some(4),
    Some(5),
    Some(6),
    Some(8),
];
const AOT: [&str; 4] = ["AAC Main", "AAC LC", "AAC SSR", "AAC LTP"];

fn bitrate_kbps(index: u32, codec_index: u32) -> Option<f64> {
    // Rows 1..14 of `bitrate_index`, columns 11, 12, 13, 21, 22, 23.
    const T: [[u32; 6]; 14] = [
        [32, 32, 32, 32, 8, 8],
        [64, 48, 40, 48, 16, 16],
        [96, 56, 48, 56, 24, 24],
        [128, 64, 56, 64, 32, 32],
        [160, 80, 64, 80, 40, 40],
        [192, 96, 80, 96, 48, 48],
        [224, 112, 96, 112, 56, 56],
        [256, 128, 112, 128, 64, 64],
        [288, 160, 128, 144, 80, 80],
        [320, 192, 160, 160, 96, 96],
        [352, 224, 192, 176, 112, 112],
        [384, 256, 224, 192, 128, 128],
        [416, 320, 256, 224, 144, 144],
        [448, 384, 320, 256, 160, 160],
    ];
    let col = match codec_index {
        11 => 0,
        12 => 1,
        13 => 2,
        21 => 3,
        22 => 4,
        23 => 5,
        _ => return None,
    };
    T.get(index as usize - 1).map(|r| f64::from(r[col]))
}

fn parse_header(b: &[u8; 4]) -> Result<Header, String> {
    let version_index = bits(b, 1, 3, 2);
    let layer = LAYERS[bits(b, 1, 5, 2) as usize];
    let protected_by_crc = !bit_set(b, 1, 7);
    if version_index > 1 && layer == 0 {
        let version = if version_index == 2 { 4.0 } else { 2.0 };
        let profile = AOT[bits(b, 2, 0, 2) as usize];
        return Ok(Header {
            version: Some(version),
            layer,
            adts: true,
            bitrate: None,
            sampling_rate: MPEG4_RATES[bits(b, 2, 2, 4) as usize],
            padding: false,
            channel_mode_index: 0,
            frame_length: (bits(b, 3, 6, 2) as usize) << 11,
            codec_profile: Some(profile),
            mp4_channels: MPEG4_CHANNELS[bits(b, 2, 7, 3) as usize],
            protected_by_crc,
        });
    }
    let bitrate_index = bits(b, 2, 0, 4);
    let samp_index = bits(b, 2, 4, 2);
    let version: Option<f64> = [Some(2.5), None, Some(2.0), Some(1.0)][version_index as usize];
    let kbps = if bitrate_index == 0 || bitrate_index == 15 {
        None
    } else {
        version.and_then(|v| bitrate_kbps(bitrate_index, 10 * (v.floor() as u32) + layer))
    };
    let Some(kbps) = kbps else {
        return Err("Cannot determine bit-rate".into());
    };
    let sampling_rate = match (version, samp_index) {
        (_, 3) | (None, _) => None,
        (Some(v), i) => {
            let row: [f64; 3] = if v == 1.0 {
                [44100.0, 48000.0, 32000.0]
            } else if v == 2.0 {
                [22050.0, 24000.0, 16000.0]
            } else {
                [11025.0, 12000.0, 8000.0]
            };
            Some(row[i as usize])
        }
    };
    if sampling_rate.is_none() {
        return Err("Cannot determine sampling-rate".into());
    }
    Ok(Header {
        version,
        layer,
        adts: false,
        bitrate: Some(kbps * 1000.0),
        sampling_rate,
        padding: bit_set(b, 2, 6),
        channel_mode_index: bits(b, 3, 0, 2),
        frame_length: 0,
        codec_profile: None,
        mp4_channels: None,
        protected_by_crc,
    })
}

impl Header {
    fn samples_per_frame(&self) -> f64 {
        let row = if self.version == Some(1.0) {
            [0.0, 384.0, 1152.0, 1152.0]
        } else {
            [0.0, 384.0, 1152.0, 576.0]
        };
        row[self.layer as usize]
    }
    fn side_info_length(&self) -> Option<usize> {
        if self.layer != 3 {
            return Some(2);
        }
        let v = self.version?;
        let mono = self.channel_mode_index == 3;
        match (mono, v == 1.0, v == 2.0 || v == 2.5) {
            (true, true, _) => Some(17),
            (true, false, true) => Some(9),
            (false, true, _) => Some(32),
            (false, false, true) => Some(17),
            _ => None,
        }
    }
}

struct Parser<'c> {
    c: &'c mut Collector,
    duration_opt: bool,
    frame_count: i64,
    sync_frame_count: i64,
    total_data_length: f64,
    bitrates: Vec<f64>,
    offset: i64,
    frame_size: i64,
    calculate_eof_duration: bool,
    samples_per_frame: Option<f64>,
    frame_header: [u8; 4],
    mpeg_offset: Option<usize>,
    audio_frame_header: Option<Header>,
    peek_buf: [u8; MAX_PEEK],
}

pub fn parse(t: &mut Tok, c: &mut Collector, duration: bool, _ape: bool) -> PResult<()> {
    let mut p = Parser {
        c,
        duration_opt: duration,
        frame_count: 0,
        sync_frame_count: -1,
        total_data_length: 0.0,
        bitrates: Vec::new(),
        offset: 0,
        frame_size: 0,
        calculate_eof_duration: false,
        samples_per_frame: None,
        frame_header: [0; 4],
        mpeg_offset: None,
        audio_frame_header: None,
        peek_buf: [0; MAX_PEEK],
    };
    // AbstractID3Parser.parse: an end of stream anywhere stops quietly (no ID3v1, no finalize).
    match p.parse_id3v2(t) {
        Err(PErr::Eof) => Ok(()),
        r => r,
    }
}

impl Parser<'_> {
    fn parse_id3v2(&mut self, t: &mut Tok) -> PResult<()> {
        tags::try_read_id3v2_headers(t, self.c)?;
        self.post_id3v2_parse(t)?;
        tags::parse_id3v1(t, self.c);
        self.finalize(t);
        Ok(())
    }

    fn post_id3v2_parse(&mut self, t: &mut Tok) -> PResult<()> {
        let r = (|| -> PResult<()> {
            loop {
                self.sync(t)?;
                if self.parse_common_header(t)? {
                    return Ok(());
                }
            }
        })();
        match r {
            Err(PErr::Eof) => {
                if self.calculate_eof_duration
                    && let Some(spf) = self.samples_per_frame
                {
                    let n = self.frame_count as f64 * spf;
                    if let Some(sr) = self.c.format.get("sampleRate").filter(|s| *s != 0.0) {
                        self.c.format.set("duration", n / sr);
                    }
                }
                Ok(())
            }
            other => other,
        }
    }

    fn finalize(&mut self, t: &Tok) {
        let Some(mpeg_offset) = self.mpeg_offset else {
            return;
        };
        let size = t.size() as f64;
        let id3v1 = if self.c.id3v1_native { 128.0 } else { 0.0 };
        let mpeg_size = size - mpeg_offset as f64 - id3v1;
        let profile = self.c.format.codec_profile.clone();
        if let Some(d) = self
            .c
            .format
            .get("duration")
            .filter(|d| *d != 0.0 && !d.is_nan())
            && size != 0.0
            && profile.as_deref().is_some_and(|p| p.starts_with('V'))
        {
            self.c.format.set("bitrate", mpeg_size * 8.0 / d);
        }
        if size != 0.0
            && profile.as_deref() == Some("CBR")
            && let Some(spf) = self.samples_per_frame
        {
            let n = js::math_round(mpeg_size / self.frame_size as f64) * spf;
            let has_duration = self
                .c
                .format
                .get("duration")
                .is_some_and(|d| d != 0.0 && !d.is_nan());
            if let Some(sr) = self.c.format.get("sampleRate").filter(|s| *s != 0.0)
                && !has_duration
            {
                self.c.format.set("duration", n / sr);
            }
        }
    }

    fn sync(&mut self, t: &mut Tok) -> PResult<()> {
        let mut got_first_sync = false;
        loop {
            let mut bo: usize = 0;
            let peek = t.peek_less(MAX_PEEK);
            let len = peek.len();
            self.peek_buf[..len].copy_from_slice(peek);
            if len <= 163 {
                return Err(PErr::Eof);
            }
            loop {
                if got_first_sync && bo < MAX_PEEK && (self.peek_buf[bo] & 0xe0) == 0xe0 {
                    self.frame_header[0] = 0xff;
                    self.frame_header[1] = self.peek_buf[bo];
                    t.ignore(bo);
                    if self.sync_frame_count == self.frame_count {
                        self.frame_count = 0;
                        self.frame_size = 0;
                    }
                    self.sync_frame_count = self.frame_count;
                    return Ok(());
                }
                got_first_sync = false;
                let found = if bo < MAX_PEEK {
                    self.peek_buf[bo..]
                        .iter()
                        .position(|&b| b == 0xff)
                        .map(|i| i + bo)
                } else {
                    None
                };
                match found {
                    None => {
                        if len < MAX_PEEK {
                            return Err(PErr::Eof);
                        }
                        t.ignore(len);
                        break;
                    }
                    Some(i) => {
                        bo = i + 1;
                        got_first_sync = true;
                    }
                }
            }
        }
    }

    fn parse_common_header(&mut self, t: &mut Tok) -> PResult<bool> {
        if self.frame_count == 0 {
            self.mpeg_offset = Some(t.pos.saturating_sub(1));
        }
        let three = t.peek(3)?;
        self.frame_header[1..4].copy_from_slice(three);
        let header = match parse_header(&self.frame_header) {
            Ok(h) => h,
            Err(_) => {
                t.ignore(1);
                return Ok(false);
            }
        };
        t.ignore(3);
        match header.sampling_rate {
            Some(sr) => self.c.format.set("sampleRate", sr),
            None => self.c.format.unset("sampleRate"),
        }
        self.frame_count += 1;
        if header.adts && header.version.is_some_and(|v| v >= 2.0) && header.layer == 0 {
            self.parse_adts(t, header)
        } else {
            self.parse_audio_frame_header(t, header)
        }
    }

    fn parse_audio_frame_header(&mut self, t: &mut Tok, header: Header) -> PResult<bool> {
        self.c.format.set(
            "numberOfChannels",
            if header.channel_mode_index == 3 {
                1.0
            } else {
                2.0
            },
        );
        if let Some(b) = header.bitrate {
            self.c.format.set("bitrate", b);
        }
        let slot = [0.0, 4.0, 1.0, 1.0][header.layer as usize];
        let spf = header.samples_per_frame();
        let bps = spf / 8.0;
        if let (Some(br), Some(sr)) = (header.bitrate, header.sampling_rate) {
            let fsize = bps * br / sr + if header.padding { slot } else { 0.0 };
            self.frame_size = fsize.floor() as i64;
        }
        if let Some(b) = header.bitrate {
            self.bitrates.push(b);
        }
        let protected = header.protected_by_crc;
        self.audio_frame_header = Some(header);
        if self.frame_count == 1 {
            self.offset = 4;
            self.skip_side_information(t)?;
            return Ok(false);
        }
        if self.frame_count == 4 {
            let first = self.bitrates[0];
            if self.bitrates.iter().all(|b| *b == first) {
                self.samples_per_frame = Some(spf);
                self.c.format.codec_profile = Some("CBR".into());
                if t.size() != 0 {
                    return Ok(true);
                }
            } else if self
                .c
                .format
                .get("duration")
                .is_some_and(|d| d != 0.0 && !d.is_nan())
            {
                return Ok(true);
            }
            if !self.duration_opt {
                return Ok(true);
            }
        }
        if self.duration_opt && self.frame_count == 4 {
            self.samples_per_frame = Some(spf);
            self.calculate_eof_duration = true;
        }
        self.offset = 4;
        if protected {
            t.ignore(2);
            self.offset += 2;
        }
        self.skip_side_information(t)?;
        Ok(false)
    }

    fn parse_adts(&mut self, t: &mut Tok, mut header: Header) -> PResult<bool> {
        let b = t.read(3)?;
        header.frame_length += bits(b, 0, 0, 11) as usize;
        self.total_data_length += header.frame_length as f64;
        self.samples_per_frame = Some(1024.0);
        if let Some(sr) = header.sampling_rate {
            let frames_per_sec = sr / 1024.0;
            let bytes_per_frame = if self.frame_count == 0 {
                0.0
            } else {
                self.total_data_length / self.frame_count as f64
            };
            self.c
                .format
                .set("bitrate", 8.0 * bytes_per_frame * frames_per_sec + 0.5);
        }
        t.ignore(if header.frame_length > 7 {
            header.frame_length - 7
        } else {
            1
        });
        if self.frame_count == 3 {
            self.c.format.codec_profile = header.codec_profile.map(str::to_string);
            if let Some(ch) = header.mp4_channels {
                self.c.format.set("numberOfChannels", ch as f64);
            }
            if self.duration_opt {
                self.calculate_eof_duration = true;
            } else {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn skip_side_information(&mut self, t: &mut Tok) -> PResult<()> {
        let Some(len) = self
            .audio_frame_header
            .as_ref()
            .and_then(Header::side_info_length)
        else {
            return Ok(());
        };
        t.read(len)?;
        self.offset += len as i64;
        self.read_xtra_info_header(t)
    }

    fn read_xtra_info_header(&mut self, t: &mut Tok) -> PResult<()> {
        let tag = latin1(t.read(4)?);
        self.offset += 4;
        match tag.as_str() {
            "Info" => {
                self.c.format.codec_profile = Some("CBR".into());
                return self.read_xing_info_header(t).map(|_| ());
            }
            "Xing" => {
                if let Some(scale) = self.read_xing_info_header(t)? {
                    self.c.format.codec_profile =
                        Some(format!("V{}", ((100.0 - scale) / 10.0).floor()));
                }
                return Ok(());
            }
            "Xtra" => {}
            "LAME" => {
                t.read(6)?;
                if self.frame_size >= self.offset + 6 {
                    self.offset += 6;
                    return self.skip_frame_data(t, self.frame_size - self.offset);
                }
            }
            _ => {}
        }
        let left = self.frame_size - self.offset;
        if left >= 0 {
            self.skip_frame_data(t, left)?;
        }
        Ok(())
    }

    /// `readXingInfoHeader`: the VBR scale, if the tag has one.
    fn read_xing_info_header(&mut self, t: &mut Tok) -> PResult<Option<f64>> {
        let start = t.pos;
        let flags = u32be(t.read(4)?, 0);
        let num_frames = if flags & 1 != 0 {
            Some(f64::from(u32be(t.read(4)?, 0)))
        } else {
            None
        };
        let stream_size = if flags & 2 != 0 {
            Some(u32be(t.read(4)?, 0))
        } else {
            None
        };
        if flags & 4 != 0 {
            t.read(100)?;
        }
        let vbr_scale = if flags & 8 != 0 {
            Some(f64::from(u32be(t.read(4)?, 0)))
        } else {
            None
        };
        if t.peek(4)? == b"LAME" {
            t.ignore(4);
            let version = latin1(t.read(5)?);
            if lame_extended(&version) {
                let ext = t.read(27)?;
                self.c
                    .format
                    .set("duration", f64::from(u32be(ext, 20)) / 1000.0);
            }
        }
        self.offset += (t.pos - start) as i64;
        if stream_size.is_some_and(|s| s != 0)
            && let (Some(h), Some(n)) = (&self.audio_frame_header, num_frames)
        {
            match h.sampling_rate {
                Some(sr) => self
                    .c
                    .format
                    .set("duration", n * h.samples_per_frame() / sr),
                None => self.c.format.unset("duration"),
            }
            return Ok(vbr_scale);
        }
        self.skip_frame_data(t, self.frame_size - self.offset)?;
        Ok(vbr_scale)
    }

    fn skip_frame_data(&mut self, t: &mut Tok, left: i64) -> PResult<()> {
        if left < 0 {
            return Err(PErr::Msg("frame-data-left cannot be negative".into()));
        }
        t.ignore(left as usize);
        Ok(())
    }
}

/// `version.match(/\d+.\d+/g)` then major >= 3 && minor >= 90.
fn lame_extended(version: &str) -> bool {
    let b = version.as_bytes();
    for start in 0..b.len() {
        let mut i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start || i + 1 >= b.len() {
            continue;
        }
        let dot = i;
        let mut j = dot + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == dot + 1 {
            continue;
        }
        let major: u32 = version[start..dot].parse().unwrap_or(0);
        let minor: u32 = version[dot + 1..j].parse().unwrap_or(0);
        return major >= 3 && minor >= 90;
    }
    false
}
