//! `OggParser` with `VorbisStream`, music-metadata 11.16.1 `lib/ogg/`. Other Ogg codecs (Opus,
//! FLAC, Speex, Theora) are not ported: the probe fails on them.

use super::flac::read_comments;
use super::tags::Collector;
use super::{PErr, PResult, Tok, latin1, u32le};

struct PageHeader {
    continued: bool,
    first: bool,
    last: bool,
    granule: f64,
}

#[derive(Default)]
struct Stream {
    serial: u32,
    page_number: u32,
    closed: bool,
    has_consumer: bool,
    metadata_complete: bool,
    last_header: Option<PageHeader>,
    segments: Vec<Vec<u8>>,
}

pub fn parse(t: &mut Tok, c: &mut Collector, duration: bool) -> PResult<()> {
    let mut streams: Vec<Stream> = Vec::new();
    let mut end_of_stream = false;
    let mut stopped_early = false;
    let r = (|| -> PResult<()> {
        loop {
            let h = t.read(27)?;
            if &h[0..4] != b"OggS" {
                return Err(PErr::Msg("ogg-content".into()));
            }
            let flags = h[5];
            let header = PageHeader {
                continued: flags & 1 != 0,
                first: flags & 2 != 0,
                last: flags & 4 != 0,
                granule: u64::from_le_bytes([h[6], h[7], h[8], h[9], h[10], h[11], h[12], h[13]])
                    as f64,
            };
            let serial = u32le(h, 14);
            let seq = u32le(h, 18);
            let segs = usize::from(h[26]);
            let idx = match streams.iter().position(|s| s.serial == serial) {
                Some(i) => i,
                None => {
                    streams.push(Stream {
                        serial,
                        ..Default::default()
                    });
                    streams.len() - 1
                }
            };
            let total: usize = t.read(segs)?.iter().map(|&b| usize::from(b)).sum();
            let page = t.read(total)?.to_vec();
            let s = &mut streams[idx];
            s.page_number = seq;
            if header.first {
                let id: String = latin1(&page[..page.len().min(7)])
                    .chars()
                    .filter(|ch| (' '..='~').contains(ch))
                    .collect();
                if id != "vorbis" {
                    return match id.as_str() {
                        "OpusHea" | "Speex  " | "fishead" | "theora" | "FLAC" => Err(PErr::Msg(
                            format!("Ogg codec not supported by this port (id={id})"),
                        )),
                        _ => Err(PErr::Msg("ogg-content".into())),
                    };
                }
                s.has_consumer = true;
            }
            if header.last {
                s.closed = true;
            }
            if !s.has_consumer {
                return Err(PErr::Msg("pageConsumer should be initialized".into()));
            }
            vorbis_page(c, s, header, page)?;
            // Without `duration`, stop once every stream's metadata is read (Vorbis needs the
            // last page for its duration, so with it the whole file is read).
            if streams[idx].page_number > 12
                && !duration
                && streams.iter().all(|s| s.metadata_complete)
            {
                stopped_early = true;
                return Ok(());
            }
            if streams.iter().all(|s| s.closed) {
                return Ok(());
            }
        }
    })();
    match r {
        Ok(()) => {}
        Err(PErr::Eof) => end_of_stream = true,
        // OggContentError: a warning, and parsing stops.
        Err(PErr::Msg(m)) if m == "ogg-content" => {}
        Err(e) => return Err(e),
    }
    for s in &mut streams {
        if !s.closed && s.has_consumer && !stopped_early {
            let merged: Vec<u8> = s.segments.concat();
            full_page(c, &merged)?;
        }
        if let Some(h) = &s.last_header
            && (end_of_stream || h.last)
            && let Some(sr) = c.format.get("sampleRate").filter(|s| *s != 0.0)
            && h.granule >= 0.0
        {
            c.format.set("duration", h.granule / sr);
        }
    }
    Ok(())
}

fn vorbis_page(
    c: &mut Collector,
    s: &mut Stream,
    header: PageHeader,
    page: Vec<u8>,
) -> PResult<()> {
    let (first, last, continued) = (header.first, header.last, header.continued);
    s.last_header = Some(header);
    if first {
        if page.len() < 7 || &page[1..7] != b"vorbis" {
            return Err(PErr::Msg("Metadata does not look like Vorbis".into()));
        }
        if page[0] != 1 {
            return Err(PErr::Msg(
                "First Ogg page should be type 1: the identification header".into(),
            ));
        }
        if page.len() < 7 + 17 {
            return Err(PErr::Msg(
                "Offset is outside the bounds of the DataView".into(),
            ));
        }
        c.format.set("sampleRate", f64::from(u32le(&page, 7 + 5)));
        c.format.set("bitrate", f64::from(u32le(&page, 7 + 13)));
        c.format.set("numberOfChannels", f64::from(page[7 + 4]));
        return Ok(());
    }
    if continued {
        if s.segments.is_empty() {
            return Err(PErr::Msg("Cannot continue on previous page".into()));
        }
        s.segments.push(page.clone());
    }
    if last || !continued {
        if !s.segments.is_empty() {
            let merged: Vec<u8> = s.segments.concat();
            if full_page(c, &merged)? {
                s.metadata_complete = true;
            }
        }
        s.segments = if last { Vec::new() } else { vec![page] };
    }
    Ok(())
}

/// Parses a full Vorbis packet; true when it was the comment header.
fn full_page(c: &mut Collector, data: &[u8]) -> PResult<bool> {
    let Some(&packet_type) = data.first() else {
        return Err(PErr::Msg(
            "Offset is outside the bounds of the DataView".into(),
        ));
    };
    if packet_type == 3 {
        read_comments(&data[7.min(data.len())..], c)?;
        return Ok(true);
    }
    Ok(false)
}
