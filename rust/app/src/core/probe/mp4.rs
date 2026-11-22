//! `MP4Parser`, music-metadata 11.16.1 `lib/mp4/`: atom walk, track boxes, iTunes tags.
//! Fragmented files (`moof`/`traf`) are not ported: their samples are not counted.

use super::tags::Collector;
use super::{PErr, PResult, Tok, latin1, u16be, u32be};

const MAX_PAYLOAD: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct Track {
    id: Option<u32>,
    handler: Option<String>,
    time_scale: Option<f64>,
    duration: Option<f64>,
    ssd: Vec<Ssd>,
    sample_sizes: Option<Vec<f64>>,
    stts: Vec<(f64, f64)>,
}

struct Ssd {
    /// numAudioChannels, sampleRate
    description: Option<(f64, f64)>,
}

#[derive(Default)]
struct State {
    tracks: Vec<Track>,
}

fn i32be(b: &[u8], o: usize) -> i32 {
    i32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn i16be(b: &[u8], o: usize) -> i16 {
    i16::from_be_bytes([b[o], b[o + 1]])
}
fn oob() -> PErr {
    PErr::Msg("Offset is outside the bounds of the DataView".into())
}
fn need(b: &[u8], n: usize) -> PResult<()> {
    if b.len() < n { Err(oob()) } else { Ok(()) }
}
fn validate_payload(len: usize) -> PResult<()> {
    if len > MAX_PAYLOAD {
        return Err(PErr::Msg(format!(
            "Atom payload exceeds the 64 MiB buffering limit: {len}"
        )));
    }
    Ok(())
}

pub fn parse(t: &mut Tok, c: &mut Collector) -> PResult<()> {
    let mut st = State::default();
    let mut remaining = t.size();
    while remaining > 0 {
        match t.peek(8) {
            Ok(h) if h[4..8] == [0, 0, 0, 0] => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let len = read_atom(t, c, &mut st, &[], remaining)?;
        remaining = if len == 0 {
            0
        } else {
            remaining.saturating_sub(len)
        };
    }
    let audio: Vec<&Track> = st.tracks.iter().filter(|tr| is_audio(tr)).collect();
    let mut first: Option<(f64, Option<f64>)> = None;
    for tr in &audio {
        let mut duration = None;
        let mut size = None;
        if let Some(ts) = tr.time_scale.filter(|ts| *ts > 0.0) {
            if let Some(d) = tr.duration.filter(|d| *d > 0.0) {
                duration = Some(d / ts);
            }
            match &tr.sample_sizes {
                Some(s) if !s.is_empty() => size = Some(s.iter().sum::<f64>()),
                Some(_) => {}
                None => {
                    return Err(PErr::Msg(
                        "Cannot read properties of undefined (reading 'length')".into(),
                    ));
                }
            }
        }
        if let Some(Some((ch, sr))) = tr.ssd.first().map(|s| s.description)
            && tr.time_scale.is_some()
        {
            c.format.set("sampleRate", sr);
            c.format.set("numberOfChannels", ch);
            if tr.time_scale == Some(0.0) && !tr.stts.is_empty() {
                let total: f64 = tr.stts.iter().map(|(n, d)| n * d).sum();
                duration = Some(total / sr);
            }
        }
        if first.is_none() {
            first = Some((duration.unwrap_or(0.0), size));
        }
    }
    if let Some((d, size)) = first
        && d != 0.0
        && !d.is_nan()
    {
        c.format.set("duration", d);
        if let Some(s) = size.filter(|s| *s != 0.0) {
            c.format.set("bitrate", 8.0 * s / d);
        }
    }
    Ok(())
}

fn is_audio(tr: &Track) -> bool {
    let Some(ssd) = tr.ssd.first() else {
        return false;
    };
    match &tr.handler {
        Some(h) => h == "audi" || h == "soun",
        None => ssd.description.is_some_and(|(ch, _)| ch > 0.0),
    }
}

/// `Atom.readAtom`: returns the atom's declared length (0: to the end).
fn read_atom(
    t: &mut Tok,
    c: &mut Collector,
    st: &mut State,
    path: &[String],
    remaining: usize,
) -> PResult<usize> {
    let remaining = remaining.min(t.size().saturating_sub(t.pos));
    if remaining < 8 {
        return Err(PErr::Msg("Truncated atom header".into()));
    }
    let h = t.read(8)?;
    let mut length = u64::from(u32be(h, 0));
    let name = latin1(&h[4..8]);
    let extended = length == 1;
    if extended {
        if remaining < 16 {
            return Err(PErr::Msg("Truncated extended atom header".into()));
        }
        let e = t.read(8)?;
        length = u64::from_be_bytes([e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7]]);
    }
    let header_len: u64 = if extended { 16 } else { 8 };
    if (extended || length != 0) && length < header_len {
        return Err(PErr::Msg(format!("Invalid atom size: {length}")));
    }
    let len = if length == 0 {
        remaining as u64
    } else {
        length
    };
    if len > remaining as u64 {
        return Err(PErr::Msg(format!(
            "Atom size exceeds remaining bytes: {length} > {remaining}"
        )));
    }
    let payload = (len - header_len) as usize;
    let mut child_path = path.to_vec();
    child_path.push(name.clone());
    match name.as_str() {
        "moov" | "udta" | "mdia" | "minf" | "stbl" | "<id>" | "ilst" | "tref" | "moof" => {
            read_atoms(t, c, st, &child_path, payload)?;
        }
        "meta" => {
            if payload < 8 {
                return Err(PErr::Msg("Truncated meta atom".into()));
            }
            let pad = if t.peek(8)?[4..8] == *b"hdlr" { 0 } else { 4 };
            t.ignore(pad);
            read_atoms(t, c, st, &child_path, payload - pad)?;
        }
        _ => handle_atom(t, c, st, path, &name, payload)?,
    }
    Ok(length as usize)
}

fn read_atoms(
    t: &mut Tok,
    c: &mut Collector,
    st: &mut State,
    path: &[String],
    mut size: usize,
) -> PResult<()> {
    while size > 0 {
        let len = read_atom(t, c, st, path, size)?;
        size = if len == 0 {
            0
        } else {
            size.saturating_sub(len)
        };
    }
    Ok(())
}

fn handle_atom(
    t: &mut Tok,
    c: &mut Collector,
    st: &mut State,
    path: &[String],
    name: &str,
    payload: usize,
) -> PResult<()> {
    let parent = path.last().map(String::as_str);
    let in_track = path.iter().any(|p| p == "trak");
    // Inside a track box every leaf goes to the track's own handler (`parseTrackBox`).
    if in_track {
        return track_child(t, st, name, payload);
    }
    if matches!(parent, Some("ilst") | Some("<id>")) {
        return parse_metadata_item(t, c, name, payload);
    }
    if parent == Some("moov") && name == "trak" {
        st.tracks.push(Track::default());
        let mut child = path.to_vec();
        child.push("trak".into());
        read_atoms(t, c, st, &child, payload)?;
        if st.tracks.last().is_some_and(|tr| tr.id.is_none()) {
            return Err(PErr::Msg(
                "Cannot read properties of undefined (reading 'trackId')".into(),
            ));
        }
        // `tracks.set(trackId, track)`: a repeated id replaces the earlier track in its place.
        if let Some(tr) = st.tracks.pop() {
            match st.tracks.iter().position(|o| o.id == tr.id) {
                Some(i) => st.tracks[i] = tr,
                None => st.tracks.push(tr),
            }
        }
        return Ok(());
    }
    match name {
        "mvhd" => {
            validate_payload(payload)?;
            if payload < 100 {
                return Err(PErr::Msg(format!(
                    "Atom mvhd expected to be 100, but specifies {payload} bytes long."
                )));
            }
            t.read(payload)?;
        }
        "ftyp" => {
            validate_payload(payload)?;
            if payload < 8 || !payload.is_multiple_of(4) {
                return Err(PErr::Msg(format!("Invalid ftyp payload length: {payload}")));
            }
            t.read(payload)?;
        }
        "chap" | "stsd" | "stsz" | "date" => {
            validate_payload(payload)?;
            t.read(payload)?;
        }
        _ => t.ignore(payload),
    }
    Ok(())
}

fn track_child(t: &mut Tok, st: &mut State, name: &str, payload: usize) -> PResult<()> {
    let Some(tr) = st.tracks.last_mut() else {
        t.ignore(payload);
        return Ok(());
    };
    match name {
        "tkhd" => {
            validate_payload(payload)?;
            let b = t.read(payload)?;
            let truncated = || PErr::Msg("Truncated tkhd header".into());
            if b.len() < 4 {
                return Err(truncated());
            }
            match b[0] {
                0 if b.len() >= 38 => tr.id = Some(u32be(b, 12)),
                1 if b.len() >= 50 => tr.id = Some(u32be(b, 20)),
                0 | 1 => return Err(truncated()),
                _ => return Err(PErr::Msg("Invalid tkhd version header".into())),
            }
        }
        "hdlr" => {
            validate_payload(payload)?;
            let b = t.read(payload)?;
            need(b, 12)?;
            tr.handler = Some(String::from_utf8_lossy(&b[8..12]).into_owned());
        }
        "mdhd" => {
            validate_payload(payload)?;
            if payload < 24 {
                return Err(PErr::Msg(format!(
                    "Atom mdhd expected to be 24, but specifies {payload} bytes long."
                )));
            }
            let b = t.read(payload)?;
            match b[0] {
                0 => {
                    tr.time_scale = Some(f64::from(u32be(b, 12)));
                    tr.duration = Some(f64::from(u32be(b, 16)));
                }
                1 => {
                    need(b, 36)?;
                    tr.time_scale = Some(f64::from(u32be(b, 20)));
                    tr.duration = Some(u64::from_be_bytes([
                        b[24], b[25], b[26], b[27], b[28], b[29], b[30], b[31],
                    ]) as f64);
                }
                _ => return Err(PErr::Msg("Invalid mdhd version header".into())),
            }
        }
        "stsd" => {
            validate_payload(payload)?;
            let b = t.read(payload)?;
            if b.len() < 8 {
                return Err(PErr::Msg("Truncated stsd header".into()));
            }
            let n = u32be(b, 4);
            let mut off = 8;
            let mut table = Vec::new();
            for _ in 0..n {
                if b.len() - off < 4 {
                    return Err(PErr::Msg("Truncated stsd sample entry".into()));
                }
                let size = u32be(b, off) as usize;
                if size < 16 || size > b.len() - off {
                    return Err(PErr::Msg(format!("Invalid stsd sample entry size: {size}")));
                }
                let entry = &b[off + 4..off + size];
                let descr = &entry[12.min(entry.len())..];
                let description = if descr.len() >= 8
                    && matches!(i16be(descr, 0), 0 | 1)
                    && descr.len() >= 8 + 12
                {
                    let d = &descr[8..];
                    let rate = f64::from(u16be(d, 8)) + f64::from(u16be(d, 10)) / 10000.0;
                    Some((f64::from(i16be(d, 0)), rate))
                } else {
                    None
                };
                table.push(Ssd { description });
                off += size;
            }
            tr.ssd = table;
        }
        "stsz" => {
            validate_payload(payload)?;
            let b = t.read(payload)?;
            need(b, 12)?;
            let n = i32be(b, 8).max(0) as usize;
            let avail = (b.len() - 12) / 4;
            tr.sample_sizes = Some(
                (0..n.min(avail))
                    .map(|i| f64::from(i32be(b, 12 + 4 * i)))
                    .collect(),
            );
        }
        "stts" => {
            validate_payload(payload)?;
            let b = t.read(payload)?;
            need(b, 8)?;
            let n = i32be(b, 4).max(0) as usize;
            let avail = (b.len() - 8) / 8;
            tr.stts = (0..n.min(avail))
                .map(|i| {
                    (
                        f64::from(i32be(b, 8 + 8 * i)),
                        f64::from(i32be(b, 12 + 8 * i)),
                    )
                })
                .collect();
        }
        "chap" | "stco" | "stsc" => {
            validate_payload(payload)?;
            t.read(payload)?;
        }
        _ => t.ignore(payload),
    }
    Ok(())
}

/// `parseMetadataItemData`: an iTunes item (`©nam`, `----` with `mean`/`name`, ...).
fn parse_metadata_item(t: &mut Tok, c: &mut Collector, name: &str, payload: usize) -> PResult<()> {
    let mut tag_key = name.to_string();
    let mut size = payload;
    while size > 0 {
        let remaining = size.min(t.size().saturating_sub(t.pos));
        if remaining < 8 {
            return Err(PErr::Msg("Truncated atom header".into()));
        }
        let h = t.read(8)?;
        let length = u32be(h, 0) as usize;
        let child = latin1(&h[4..8]);
        if length == 1 {
            return Err(PErr::Msg(
                "extended atoms in iTunes items are not ported".into(),
            ));
        }
        if length != 0 && length < 8 {
            return Err(PErr::Msg(format!("Invalid atom size: {length}")));
        }
        let len = if length == 0 { remaining } else { length };
        if len > remaining {
            return Err(PErr::Msg(format!(
                "Atom size exceeds remaining bytes: {length} > {remaining}"
            )));
        }
        let p = len - 8;
        validate_payload(p)?;
        let b = t.read(p)?;
        match child.as_str() {
            "data" => {
                need(b, 8)?;
                if b[0] != 0 {
                    return Err(PErr::Msg(format!("Unsupported type-set != 0: {}", b[0])));
                }
                let ty = (u32::from(b[1]) << 16) | (u32::from(b[2]) << 8) | u32::from(b[3]);
                if ty == 1 || ty == 18 {
                    c.add_tag(
                        "iTunes",
                        &tag_key,
                        String::from_utf8_lossy(&b[8..]).into_owned(),
                    );
                }
            }
            "name" | "mean" | "rate" => {
                need(b, 4)?;
                tag_key.push(':');
                tag_key.push_str(&String::from_utf8_lossy(&b[4..]));
            }
            _ => {}
        }
        size = if length == 0 {
            0
        } else {
            size.saturating_sub(len)
        };
    }
    Ok(())
}
