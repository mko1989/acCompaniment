//! `WaveParser`, music-metadata 11.16.1 `lib/wav/WaveParser.js`.

use super::tags::{self, Collector};
use super::{PErr, PResult, Tok, latin1, u16le, u32le};

struct Info {
    id: String,
    bytes: Vec<u8>,
}

pub fn parse(t: &mut Tok, c: &mut Collector) -> PResult<()> {
    let h = t.read(8)?;
    if &h[0..4] != b"RIFF" {
        return Ok(());
    }
    let chunk_size = u32le(h, 4) as i64;
    let mut pending: Vec<Info> = Vec::new();
    let mut code_page: Option<u32> = None;
    match parse_riff_chunk(t, c, chunk_size, &mut pending, &mut code_page) {
        Ok(()) | Err(PErr::Eof) => {}
        Err(e) => return Err(e),
    }
    flush_info_tags(c, &mut pending, code_page);
    Ok(())
}

fn info_encoding(code_page: Option<u32>) -> Option<&'static str> {
    match code_page {
        None | Some(0) | Some(28591) => Some("latin1"),
        Some(1252) => Some("windows-1252"),
        Some(65001) => Some("utf-8"),
        _ => None,
    }
}

fn add_info_tag(c: &mut Collector, info: &Info, code_page: Option<u32>) {
    let Some(enc) = info_encoding(code_page) else {
        return;
    };
    let text = if enc == "utf-8" {
        String::from_utf8_lossy(&info.bytes).into_owned()
    } else {
        latin1(&info.bytes)
    };
    let value = text.split('\0').next().unwrap_or("").to_string();
    c.add_tag("exif", &info.id, value);
}

fn flush_info_tags(c: &mut Collector, pending: &mut Vec<Info>, code_page: Option<u32>) {
    for info in pending.drain(..) {
        add_info_tag(c, &info, code_page);
    }
}

fn parse_riff_chunk(
    t: &mut Tok,
    c: &mut Collector,
    chunk_size: i64,
    pending: &mut Vec<Info>,
    code_page: &mut Option<u32>,
) -> PResult<()> {
    let ty = latin1(t.read(4)?);
    if ty != "WAVE" {
        return Err(PErr::Msg(format!("Unsupported RIFF format: RIFF/{ty}")));
    }
    let mut remaining = chunk_size - 4;
    let mut block_align: f64 = 0.0;
    let mut avg_bytes_per_sec: f64 = 0.0;
    let mut fact: Option<f64> = None;
    while remaining >= 8 {
        let h = t.read(8)?;
        let id = latin1(&h[0..4]);
        let size = u32le(h, 4) as usize;
        remaining -= 8 + size as i64;
        match id.as_str() {
            "CSET" => {
                if size < 8 {
                    return Err(PErr::Msg("CSET chunk must contain at least 8 bytes".into()));
                }
                let b = t.read(size)?;
                *code_page = Some(u16le(b, 0));
                flush_info_tags(c, pending, *code_page);
            }
            "LIST" => {
                let list_type = latin1(t.read(4)?);
                if list_type == "INFO" {
                    let mut left = size as i64 - 4;
                    while left >= 8 {
                        let ih = t.read(8)?;
                        let iid = latin1(&ih[0..4]);
                        let isize = u32le(ih, 4) as usize;
                        let len = isize + (isize & 1);
                        let bytes = t.read(len)?[..isize].to_vec();
                        let info = Info { id: iid, bytes };
                        if code_page.is_none() {
                            pending.push(info);
                        } else {
                            add_info_tag(c, &info, *code_page);
                        }
                        left -= 8 + len as i64;
                    }
                    if left != 0 {
                        return Err(PErr::Msg(format!("Illegal remaining size: {left}")));
                    }
                } else {
                    t.ignore(size.saturating_sub(4));
                }
            }
            "fact" => {
                if size < 4 {
                    return Err(PErr::Msg("Invalid fact chunk size.".into()));
                }
                let b = t.read(size)?;
                fact = Some(f64::from(u32le(b, 0)));
            }
            "fmt " => {
                if size < 16 {
                    return Err(PErr::Msg("Invalid chunk size".into()));
                }
                let b = t.read(size)?;
                c.format.set("sampleRate", f64::from(u32le(b, 4)));
                c.format.set("numberOfChannels", f64::from(u16le(b, 2)));
                block_align = f64::from(u16le(b, 12));
                avg_bytes_per_sec = f64::from(u32le(b, 8));
            }
            "id3 " | "ID3 " => {
                let b = t.read(size)?;
                let mut inner = Tok { buf: b, pos: 0 };
                tags::parse_id3v2(&mut inner, c)?;
            }
            "data" => {
                let mut cs = size as f64;
                let calc_remaining = t.size() as f64 - t.pos as f64;
                if calc_remaining < cs {
                    cs = calc_remaining;
                }
                let n = match fact {
                    Some(f) => Some(f),
                    None if cs == f64::from(u32::MAX) => None,
                    None => Some(cs / block_align),
                };
                if let Some(n) = n.filter(|n| *n != 0.0 && !n.is_nan())
                    && let Some(sr) = c.format.get("sampleRate").filter(|s| *s != 0.0)
                {
                    c.format.set("duration", n / sr);
                }
                if avg_bytes_per_sec > 0.0 {
                    c.format.set("bitrate", avg_bytes_per_sec * 8.0);
                } else if let Some(d) = c
                    .format
                    .get("duration")
                    .filter(|d| *d != 0.0 && !d.is_nan())
                {
                    c.format.set("bitrate", cs * 8.0 / d);
                }
                t.ignore(size);
            }
            "bext" => {
                t.read(420)?;
                if size < 420 {
                    return Err(PErr::Msg("ignore length must be ≥ 0 bytes".into()));
                }
                t.ignore(size - 420);
            }
            _ => t.ignore(size),
        }
        if size % 2 == 1 {
            t.ignore(1);
        }
    }
    Ok(())
}
