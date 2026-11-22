//! `FlacParser`, music-metadata 11.16.1 `lib/flac/FlacParser.js`.

use super::tags::{self, Collector};
use super::{PErr, PResult, Tok, u32le};

pub fn parse(t: &mut Tok, c: &mut Collector, _ape: bool) -> PResult<()> {
    // AbstractID3Parser.parse: an end of stream stops quietly.
    match parse_inner(t, c) {
        Err(PErr::Eof) => Ok(()),
        r => r,
    }
}

fn parse_inner(t: &mut Tok, c: &mut Collector) -> PResult<()> {
    tags::try_read_id3v2_headers(t, c)?;
    if t.read(4)? != b"fLaC" {
        return Err(PErr::Msg("Invalid FLAC preamble".into()));
    }
    loop {
        let h = t.read(4)?;
        let last = h[0] & 0x80 != 0;
        let ty = h[0] & 0x7f;
        let len = (usize::from(h[1]) << 16) | (usize::from(h[2]) << 8) | usize::from(h[3]);
        match ty {
            0 => {
                if len != 34 {
                    return Err(PErr::Msg("Unexpected block-stream-info length".into()));
                }
                let b = t.read(34)?;
                let sample_rate = f64::from(
                    ((u32::from(b[10]) << 16) | (u32::from(b[11]) << 8) | u32::from(b[12])) >> 4,
                );
                let channels = f64::from(((b[12] >> 1) & 0x07) + 1);
                let total = (u64::from(b[13] & 0x0f) << 32)
                    | (u64::from(b[14]) << 24)
                    | (u64::from(b[15]) << 16)
                    | (u64::from(b[16]) << 8)
                    | u64::from(b[17]);
                c.format.set("numberOfChannels", channels);
                c.format.set("sampleRate", sample_rate);
                if total > 0 {
                    c.format.set("duration", total as f64 / sample_rate);
                }
            }
            4 => {
                let b = t.read(len)?;
                read_comments(b, c)?;
            }
            6 => {
                t.read(len)?;
            }
            _ => t.ignore(len),
        }
        if last {
            break;
        }
    }
    if t.size() != 0
        && let Some(d) = c
            .format
            .get("duration")
            .filter(|d| *d != 0.0 && !d.is_nan())
    {
        c.format.set("bitrate", 8.0 * (t.size() - t.pos) as f64 / d);
    }
    tags::parse_id3v1(t, c);
    Ok(())
}

/// A Vorbis comment block (also used by Ogg Vorbis).
pub fn read_comments(b: &[u8], c: &mut Collector) -> PResult<()> {
    let oob = || PErr::Msg("Offset is outside the bounds of the DataView".into());
    let u32_at = |o: usize| -> PResult<usize> {
        if o + 4 > b.len() {
            return Err(oob());
        }
        Ok(u32le(b, o) as usize)
    };
    let mut o = 0;
    let vendor_len = u32_at(o)?;
    o += 4 + vendor_len;
    let n = u32_at(o)?;
    o += 4;
    for _ in 0..n {
        let len = u32_at(o)?;
        o += 4;
        let end = (o + len).min(b.len());
        let v = String::from_utf8_lossy(&b[o.min(b.len())..end]).into_owned();
        o += len;
        let (key, value) = match v.find('=') {
            Some(i) => (v[..i].to_uppercase(), v[i + 1..].to_string()),
            None => (String::new(), v.clone()),
        };
        c.add_tag("vorbis", &key, value);
    }
    Ok(())
}
