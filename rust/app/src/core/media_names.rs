//! The Rust port of the pure naming helpers of `src/backend/mediaLibrary.js` (through
//! `rust/shims/media-library-names/`, ADR-014).
//!
//! The original works on JS strings: UTF-16 code units. So does this port, end to end:
//! `slice(0, 200)` counts code units and can cut a surrogate pair, `trim()` strips JS
//! whitespace (U+FEFF included, U+0085 not), and Node's POSIX `path.basename`/`path.extname`
//! are ported literally (`'a.'`, `'..mp3'` and `'.hidden'` differ from `std::path`).

#![forbid(unsafe_code)]

use crate::js;

const SLASH: u16 = b'/' as u16;
const DOT: u16 = b'.' as u16;
const SUPPORTED_EXTENSIONS: [&str; 6] = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];

/// Port of `sanitizeFilename` (`src/backend/mediaLibrary.js:36`): a safe library filename. A JS
/// string, so it may end in a lone surrogate (see [`sanitize_filename_units`]).
pub fn sanitize_filename(name: String) -> Result<serde_json::Value, String> {
    let units: Vec<u16> = name.encode_utf16().collect();
    Ok(js::utf16_string(&sanitize_filename_units(&units)))
}

/// Port of `withCopyNumber` (`src/backend/mediaLibrary.js:53`): "Song.mp3" -> "Song (2).mp3".
pub fn with_copy_number(name: String, n: f64) -> Result<String, String> {
    // `n <= 1` is false for NaN, as in JS.
    if n <= 1.0 {
        return Ok(name);
    }
    let units: Vec<u16> = name.encode_utf16().collect();
    let ext = extname(&units);
    let mut out = basename(&units, Some(ext));
    out.extend(format!(" ({})", js::number_to_string(n)).encode_utf16());
    out.extend_from_slice(ext);
    Ok(String::from_utf16_lossy(&out))
}

/// Port of `cleanLegacyName` (`src/backend/mediaLibrary.js:60`): strips the `_<13 digits>`
/// timestamp old uploads added before the extension.
pub fn clean_legacy_name(name: String) -> Result<String, String> {
    let units: Vec<u16> = name.encode_utf16().collect();
    let ext = extname(&units);
    let mut base = basename(&units, Some(ext));
    // /_\d{13}$/: `\d` is ASCII only in JS, `$` is the very end.
    let n = base.len();
    if n >= 14
        && base[n - 14] == u16::from(b'_')
        && base[n - 13..].iter().all(|&u| (0x30..=0x39).contains(&u))
    {
        base.truncate(n - 14);
    }
    base.extend_from_slice(ext);
    Ok(String::from_utf16_lossy(&base))
}

/// Port of `isSupportedAudio` (`src/backend/mediaLibrary.js:76`).
pub fn is_supported_audio(name: String) -> Result<bool, String> {
    let units: Vec<u16> = name.encode_utf16().collect();
    let ext = String::from_utf16_lossy(extname(&units)).to_lowercase();
    Ok(SUPPORTED_EXTENSIONS.contains(&ext.as_str()))
}

/// `sanitizeFilename` on UTF-16 code units, for Rust callers.
pub fn sanitize_filename_units(name: &[u16]) -> Vec<u16> {
    let slashed: Vec<u16> = name
        .iter()
        .map(|&u| if u == u16::from(b'\\') { SLASH } else { u })
        .collect();
    let cleaned: Vec<u16> = basename(&slashed, None)
        .into_iter()
        .filter(|&u| !(u <= 0x1f || u == 0x7f))
        .map(|u| {
            if b"/:*?\"<>|".iter().any(|&c| u16::from(c) == u) {
                u16::from(b'_')
            } else {
                u
            }
        })
        .collect();
    let mut clean = js_trim(&cleaned).to_vec();
    // /^\.[^.]+$/: just an extension, e.g. ".mp3".
    if clean.len() >= 2 && clean[0] == DOT && !clean[1..].contains(&DOT) {
        clean.splice(0..0, "audio".encode_utf16());
    }
    let dots = clean.iter().take_while(|&&u| u == DOT).count();
    clean.drain(..dots);
    if clean.is_empty() || clean == extname(&clean) {
        let mut audio: Vec<u16> = "audio".encode_utf16().collect();
        audio.extend_from_slice(extname(&clean));
        clean = audio;
    }
    // Windows can't create files named after its devices, with or without an extension
    // (WO-020): `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i` on the part before the first dot.
    let first = clean.split(|&u| u == DOT).next().unwrap_or(&[]);
    if is_reserved_device_name(first) {
        clean.insert(0, u16::from(b'_'));
    }
    shorten_name(clean, 200)
}

fn is_reserved_device_name(base: &[u16]) -> bool {
    let Ok(ascii) = String::from_utf16(base) else {
        return false;
    };
    if !ascii.is_ascii() {
        return false; // JS `/i` without `u` folds ASCII only
    }
    let lower = ascii.to_ascii_lowercase();
    matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && matches!(lower.as_bytes()[3], b'1'..=b'9'))
}

/// At most `max` code units, cut before the extension so it stays, and never between the two
/// halves of a surrogate pair (WO-019).
fn shorten_name(name: Vec<u16>, max: usize) -> Vec<u16> {
    if name.len() <= max {
        return name;
    }
    let ext = extname(&name).to_vec();
    let keep_ext = !ext.is_empty() && ext.len() < max;
    let mut base = if keep_ext {
        name[..name.len() - ext.len()].to_vec()
    } else {
        name
    };
    base.truncate(if keep_ext { max - ext.len() } else { max });
    if base.last().is_some_and(|&u| (0xD800..=0xDBFF).contains(&u)) {
        base.pop();
    }
    if keep_ext {
        base.extend_from_slice(&ext);
    }
    base
}

/// JS `String.prototype.trim`: WhiteSpace and LineTerminator code units at both ends.
fn js_trim(s: &[u16]) -> &[u16] {
    let ws = |u: &u16| {
        matches!(*u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029
            | 0x202f | 0x205f | 0x3000 | 0xfeff)
    };
    let start = s.iter().position(|u| !ws(u)).unwrap_or(s.len());
    let end = s.iter().rposition(|u| !ws(u)).map_or(start, |i| i + 1);
    &s[start..end]
}

/// Node's POSIX `path.extname`, on code units (lib/path.js).
fn extname(path: &[u16]) -> &[u16] {
    let (mut start_dot, mut start_part, mut end) = (None, 0, None);
    let mut matched_slash = true;
    let mut pre_dot_state = 0;
    for i in (0..path.len()).rev() {
        let code = path[i];
        if code == SLASH {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
        if code == DOT {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0
                && !(pre_dot_state == 1 && dot == end - 1 && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => &[],
    }
}

/// Node's POSIX `path.basename(path, suffix)`, on code units (lib/path.js).
fn basename(path: &[u16], suffix: Option<&[u16]>) -> Vec<u16> {
    let mut start = 0;
    let mut matched_slash = true;
    if let Some(suffix) = suffix.filter(|s| !s.is_empty() && s.len() <= path.len()) {
        if suffix == path {
            return Vec::new();
        }
        let mut ext_idx = suffix.len() as isize - 1;
        let mut end: isize = -1;
        let mut first_non_slash_end: isize = -1;
        for i in (0..path.len()).rev() {
            let code = path[i];
            if code == SLASH {
                if !matched_slash {
                    start = i + 1;
                    break;
                }
            } else {
                if first_non_slash_end == -1 {
                    matched_slash = false;
                    first_non_slash_end = i as isize + 1;
                }
                if ext_idx >= 0 {
                    if code == suffix[ext_idx as usize] {
                        ext_idx -= 1;
                        if ext_idx == -1 {
                            end = i as isize;
                        }
                    } else {
                        ext_idx = -1;
                        end = first_non_slash_end;
                    }
                }
            }
        }
        if start as isize == end {
            end = first_non_slash_end;
        } else if end == -1 {
            end = path.len() as isize;
        }
        let end = usize::try_from(end).unwrap_or(0).max(start);
        return path[start..end].to_vec();
    }
    let mut end = None;
    for i in (0..path.len()).rev() {
        if path[i] == SLASH {
            if !matched_slash {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
    }
    end.map_or_else(Vec::new, |end| path[start..end].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> String {
        x.to_string()
    }

    #[test]
    fn node_path_edges() {
        let u = |x: &str| x.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(extname(&u("a.")), u(".").as_slice());
        assert_eq!(extname(&u("..mp3")), u(".mp3").as_slice());
        assert!(extname(&u(".hidden")).is_empty());
        assert_eq!(basename(&u("a/b.wav/"), Some(&u(".wav"))), u("b"));
    }

    #[test]
    fn sanitize() {
        assert_eq!(
            sanitize_filename(s("..\\..\\evil.wav")).unwrap(),
            "evil.wav"
        );
        assert_eq!(sanitize_filename(s(".mp3")).unwrap(), "audio.mp3");
        assert_eq!(sanitize_filename(s("\u{feff}bom.wav")).unwrap(), "bom.wav");
        assert_eq!(sanitize_filename(s("")).unwrap(), "audio");
    }

    #[test]
    fn copy_numbers_and_legacy_names() {
        assert_eq!(
            with_copy_number(s("Song.mp3"), 2.0).unwrap(),
            "Song (2).mp3"
        );
        assert_eq!(
            with_copy_number(s("Song.mp3"), 1e21).unwrap(),
            "Song (1e+21).mp3"
        );
        assert_eq!(
            clean_legacy_name(s("Song_1761152917380.mp3")).unwrap(),
            "Song.mp3"
        );
        assert!(is_supported_audio(s("x.FLAC")).unwrap());
    }
}
