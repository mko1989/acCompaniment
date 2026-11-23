//! Node's `path.win32` (lib/path.js): what the original used on Windows (WO-038). `nodefs.rs`
//! uses it on Windows and the POSIX port elsewhere; it is compiled everywhere so its recorded
//! cases (`tests/unit-cases/path-win32.jsonl`, recorded from Node's `path.win32`) run on every
//! platform.
//!
//! Like Node, it works on UTF-16 code units; `resolve` takes the working directory as an
//! argument (`cwd`) so the cases can pin it.

const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const COLON: u16 = b':' as u16;
const DOT: u16 = b'.' as u16;

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn text(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

fn is_sep(c: u16) -> bool {
    c == SLASH || c == BACKSLASH
}

fn is_device_root(c: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&c)
        || (u16::from(b'a')..=u16::from(b'z')).contains(&c)
}

fn at(p: &[u16], i: usize) -> u16 {
    p.get(i).copied().unwrap_or(0)
}

/// Node's `normalizeString` with `\` as the separator.
fn normalize_string(path: &[u16], allow_above_root: bool) -> Vec<u16> {
    let mut res: Vec<u16> = Vec::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u16 = 0;
    let n = path.len();
    let last_index_of_sep = |r: &[u16]| r.iter().rposition(|&c| c == BACKSLASH);
    for i in 0..=n {
        if i < n {
            code = path[i];
        } else if is_sep(code) {
            break;
        } else {
            code = SLASH;
        }
        if is_sep(code) {
            let ii = i as isize;
            if last_slash == ii - 1 || dots == 1 {
                // nothing
            } else if dots == 2 {
                if res.len() < 2
                    || last_segment_length != 2
                    || res[res.len() - 1] != DOT
                    || res[res.len() - 2] != DOT
                {
                    if res.len() > 2 {
                        match last_index_of_sep(&res) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                last_segment_length = match last_index_of_sep(&res) {
                                    Some(j) => res.len() - 1 - j,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = ii;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = ii;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(BACKSLASH);
                    }
                    res.extend_from_slice(&[DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(BACKSLASH);
                }
                res.extend_from_slice(&path[(last_slash + 1) as usize..i]);
                last_segment_length = (ii - last_slash - 1) as usize;
            }
            last_slash = ii;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

/// The UNC root `\\server\share` of `p` (which starts with two separators): where it ends, and
/// whether nothing follows it.
fn unc_root(p: &[u16]) -> Option<(Vec<u16>, usize)> {
    let len = p.len();
    let mut j = 2;
    let mut last = j;
    while j < len && !is_sep(p[j]) {
        j += 1;
    }
    if j < len && j != last {
        let first = &p[last..j];
        last = j;
        while j < len && is_sep(p[j]) {
            j += 1;
        }
        if j < len && j != last {
            last = j;
            while j < len && !is_sep(p[j]) {
                j += 1;
            }
            if j == len || j != last {
                let mut device = vec![BACKSLASH, BACKSLASH];
                device.extend_from_slice(first);
                device.push(BACKSLASH);
                device.extend_from_slice(&p[last..j]);
                return Some((device, j));
            }
        }
    }
    None
}

/// The root of `p`: (device, where the root ends, absolute).
fn root(p: &[u16]) -> (Vec<u16>, usize, bool) {
    let len = p.len();
    let code = at(p, 0);
    if len == 1 {
        return if is_sep(code) {
            (Vec::new(), 1, true)
        } else {
            (Vec::new(), 0, false)
        };
    }
    if is_sep(code) {
        if is_sep(at(p, 1)) {
            if let Some((device, end)) = unc_root(p) {
                return (device, end, true);
            }
            return (Vec::new(), 0, true);
        }
        return (Vec::new(), 1, true);
    }
    if is_device_root(code) && at(p, 1) == COLON {
        if len > 2 && is_sep(p[2]) {
            return (p[..2].to_vec(), 3, true);
        }
        return (p[..2].to_vec(), 2, false);
    }
    (Vec::new(), 0, false)
}

fn eq_ignore_case(a: &[u16], b: &[u16]) -> bool {
    text(a).to_lowercase() == text(b).to_lowercase()
}

/// `path.win32.resolve(...paths)`, with `cwd` as `process.cwd()` and `drive_cwd("C:")` as
/// `process.env["=C:"]`.
pub fn resolve_with(
    paths: &[&str],
    cwd: &str,
    drive_cwd: &dyn Fn(&str) -> Option<String>,
) -> String {
    let mut resolved_device: Vec<u16> = Vec::new();
    let mut resolved_tail: Vec<u16> = Vec::new();
    let mut resolved_absolute = false;
    let mut i = paths.len() as isize - 1;
    while i >= -1 {
        let path: Vec<u16> = if i >= 0 {
            let p = paths[i as usize];
            if p.is_empty() {
                i -= 1;
                continue;
            }
            units(p)
        } else if resolved_device.is_empty() {
            units(cwd)
        } else {
            let device = text(&resolved_device);
            let p = units(&drive_cwd(&device).unwrap_or_else(|| cwd.to_string()));
            if !eq_ignore_case(&p[..p.len().min(2)], &resolved_device) && at(&p, 2) == BACKSLASH {
                let mut root = resolved_device.clone();
                root.push(BACKSLASH);
                root
            } else {
                p
            }
        };
        i -= 1;

        let (device, root_end, absolute) = root(&path);

        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if !eq_ignore_case(&device, &resolved_device) {
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let mut tail = path[root_end..].to_vec();
            tail.push(BACKSLASH);
            tail.extend_from_slice(&resolved_tail);
            resolved_tail = tail;
            resolved_absolute = absolute;
            if absolute && !resolved_device.is_empty() {
                break;
            }
        }
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute);
    let mut out = resolved_device;
    if resolved_absolute {
        out.push(BACKSLASH);
        out.extend_from_slice(&tail);
        text(&out)
    } else {
        out.extend_from_slice(&tail);
        if out.is_empty() {
            ".".into()
        } else {
            text(&out)
        }
    }
}

/// `path.win32.resolve(...paths)` with this process's working directories.
pub fn resolve(paths: &[&str]) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "C:\\".into());
    resolve_with(paths, &cwd, &|device| {
        std::env::var(format!("={device}")).ok()
    })
}

/// `path.win32.normalize(path)`.
pub fn normalize(path: &str) -> String {
    let p = units(path);
    let len = p.len();
    if len == 0 {
        return ".".into();
    }
    if len == 1 {
        return if p[0] == SLASH {
            "\\".into()
        } else {
            path.into()
        };
    }
    let mut device: Option<Vec<u16>> = None;
    let mut root_end = 0;
    let mut absolute = false;
    let code = p[0];
    if is_sep(code) {
        absolute = true;
        if is_sep(p[1]) {
            if let Some((d, end)) = unc_root(&p) {
                if end == len {
                    // A UNC root alone.
                    let mut out = d;
                    out.push(BACKSLASH);
                    return text(&out);
                }
                device = Some(d);
                root_end = end;
            }
        } else {
            root_end = 1;
        }
    } else if is_device_root(code) && p[1] == COLON {
        device = Some(p[..2].to_vec());
        root_end = 2;
        if len > 2 && is_sep(p[2]) {
            absolute = true;
            root_end = 3;
        }
    }
    let mut tail = if root_end < len {
        normalize_string(&p[root_end..], !absolute)
    } else {
        Vec::new()
    };
    if tail.is_empty() && !absolute {
        tail = vec![DOT];
    }
    if !tail.is_empty() && is_sep(p[len - 1]) {
        tail.push(BACKSLASH);
    }
    if !absolute && device.is_none() && p.contains(&COLON) {
        // CVE-2024-36139: a relative path must not normalize to something Windows reads as a
        // drive (`.\` in front then).
        let dot_prefixed = |t: &[u16]| {
            let mut out = vec![DOT, BACKSLASH];
            out.extend_from_slice(t);
            text(&out)
        };
        if tail.len() >= 2 && is_device_root(tail[0]) && tail[1] == COLON {
            return dot_prefixed(&tail);
        }
        for (index, _) in p.iter().enumerate().filter(|(_, c)| **c == COLON) {
            if index == len - 1 || is_sep(p[index + 1]) {
                return dot_prefixed(&tail);
            }
        }
    }
    let mut out = device.unwrap_or_default();
    if absolute {
        out.push(BACKSLASH);
    }
    out.extend_from_slice(&tail);
    text(&out)
}

/// `path.win32.isAbsolute(path)`.
pub fn is_absolute(path: &str) -> bool {
    let p = units(path);
    let Some(&code) = p.first() else {
        return false;
    };
    is_sep(code) || (p.len() > 2 && is_device_root(code) && p[1] == COLON && is_sep(p[2]))
}

/// `path.win32.join(...paths)`.
pub fn join(paths: &[&str]) -> String {
    let parts: Vec<&str> = paths.iter().copied().filter(|p| !p.is_empty()).collect();
    let Some(first) = parts.first() else {
        return ".".into();
    };
    let mut joined = units(&parts.join("\\"));
    let first = units(first);
    // A joined path that starts with two separators would read as UNC: keep one, unless the
    // first part clearly is a UNC path (exactly two separators and then a name).
    let mut needs_replace = true;
    let mut slash_count = 0;
    if is_sep(first[0]) {
        slash_count += 1;
        if first.len() > 1 && is_sep(first[1]) {
            slash_count += 1;
            if first.len() > 2 {
                if is_sep(first[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        while slash_count < joined.len() && is_sep(joined[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            let mut out = vec![BACKSLASH];
            out.extend_from_slice(&joined[slash_count..]);
            joined = out;
        }
    }
    normalize(&text(&joined))
}

/// `path.win32.relative(from, to)`, against `resolve_with(.., cwd, drive_cwd)`.
pub fn relative_with(
    from: &str,
    to: &str,
    cwd: &str,
    drive_cwd: &dyn Fn(&str) -> Option<String>,
) -> String {
    if from == to {
        return String::new();
    }
    let from_orig = resolve_with(&[from], cwd, drive_cwd);
    let to_orig = resolve_with(&[to], cwd, drive_cwd);
    if from_orig == to_orig {
        return String::new();
    }
    let from = units(&from_orig.to_lowercase());
    let to = units(&to_orig.to_lowercase());
    if from == to {
        return String::new();
    }
    let to_orig = units(&to_orig);

    let mut from_start = 0;
    while from_start < from.len() && from[from_start] == BACKSLASH {
        from_start += 1;
    }
    let mut from_end = from.len();
    while from_end > from_start + 1 && from[from_end - 1] == BACKSLASH {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start = 0;
    while to_start < to.len() && to[to_start] == BACKSLASH {
        to_start += 1;
    }
    let mut to_end = to.len();
    while to_end > to_start + 1 && to[to_end - 1] == BACKSLASH {
        to_end -= 1;
    }
    let to_len = to_end - to_start;

    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0;
    while i < length {
        let c = from[from_start + i];
        if c != to[to_start + i] {
            break;
        } else if c == BACKSLASH {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    let slice = |a: usize, b: usize| text(to_orig.get(a..b.max(a)).unwrap_or(&[]));
    if i != length {
        if last_common_sep == -1 {
            return text(&to_orig);
        }
    } else {
        if to_len > length {
            if to[to_start + i] == BACKSLASH {
                return slice(to_start + i + 1, to_orig.len());
            }
            if i == 2 {
                return slice(to_start + i, to_orig.len());
            }
        }
        if from_len > length {
            if from[from_start + i] == BACKSLASH {
                last_common_sep = i as isize;
            } else if i == 2 {
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }
    let mut out = String::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || from[j] == BACKSLASH {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        j += 1;
    }
    let mut to_start = (to_start as isize + last_common_sep) as usize;
    if !out.is_empty() {
        return format!("{out}{}", slice(to_start, to_end));
    }
    if at(&to_orig, to_start) == BACKSLASH {
        to_start += 1;
    }
    slice(to_start, to_end)
}

/// `path.win32.relative(from, to)` with this process's working directories.
pub fn relative(from: &str, to: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "C:\\".into());
    relative_with(from, to, &cwd, &|device| {
        std::env::var(format!("={device}")).ok()
    })
}

/// `path.win32.dirname(path)`.
pub fn dirname(path: &str) -> String {
    let p = units(path);
    let len = p.len();
    if len == 0 {
        return ".".into();
    }
    if len == 1 {
        return if is_sep(p[0]) {
            path.into()
        } else {
            ".".into()
        };
    }
    let mut root_end: isize = -1;
    let mut offset = 0;
    let code = p[0];
    if is_sep(code) {
        root_end = 1;
        offset = 1;
        if is_sep(p[1])
            && let Some((_, end)) = unc_root(&p)
        {
            if end == len {
                return path.into();
            }
            root_end = end as isize + 1;
            offset = end + 1;
        }
    } else if is_device_root(code) && p[1] == COLON {
        let end = if len > 2 && is_sep(p[2]) { 3 } else { 2 };
        root_end = end as isize;
        offset = end;
    }
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = len as isize - 1;
    while i >= offset as isize {
        if is_sep(p[i as usize]) {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        if root_end == -1 {
            return ".".into();
        }
        end = root_end;
    }
    text(&p[..(end as usize).min(len)])
}

/// `path.win32.basename(path, suffix?)`.
pub fn basename(path: &str, suffix: Option<&str>) -> String {
    let p = units(path);
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    if p.len() >= 2 && is_device_root(p[0]) && p[1] == COLON {
        start = 2;
    }
    let slice = |a: usize, b: usize| text(p.get(a..b.max(a)).unwrap_or(&[]));
    if let Some(sfx) = suffix
        .map(units)
        .filter(|s| !s.is_empty() && s.len() <= p.len())
    {
        if sfx == p {
            return String::new();
        }
        let mut ext_idx: isize = sfx.len() as isize - 1;
        let mut first_non_slash_end: isize = -1;
        let mut i = p.len() as isize - 1;
        while i >= start as isize {
            let code = p[i as usize];
            if is_sep(code) {
                if !matched_slash {
                    start = (i + 1) as usize;
                    break;
                }
            } else {
                if first_non_slash_end == -1 {
                    matched_slash = false;
                    first_non_slash_end = i + 1;
                }
                if ext_idx >= 0 {
                    if code == sfx[ext_idx as usize] {
                        ext_idx -= 1;
                        if ext_idx == -1 {
                            end = i;
                        }
                    } else {
                        ext_idx = -1;
                        end = first_non_slash_end;
                    }
                }
            }
            i -= 1;
        }
        if start as isize == end {
            end = first_non_slash_end;
        } else if end == -1 {
            end = p.len() as isize;
        }
        return slice(start, end.max(0) as usize);
    }
    let mut i = p.len() as isize - 1;
    while i >= start as isize {
        if is_sep(p[i as usize]) {
            if !matched_slash {
                start = (i + 1) as usize;
                break;
            }
        } else if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        i -= 1;
    }
    if end == -1 {
        return String::new();
    }
    slice(start, end as usize)
}

/// `path.win32.extname(path)`.
pub fn extname(path: &str) -> String {
    let p = units(path);
    let mut start = 0usize;
    let mut start_dot: isize = -1;
    let mut start_part: isize = 0;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut pre_dot_state = 0;
    if p.len() >= 2 && p[1] == COLON && is_device_root(p[0]) {
        start = 2;
        start_part = 2;
    }
    let mut i = p.len() as isize - 1;
    while i >= start as isize {
        let code = p[i as usize];
        if is_sep(code) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            i -= 1;
            continue;
        }
        if end == -1 {
            matched_slash = false;
            end = i + 1;
        }
        if code == DOT {
            if start_dot == -1 {
                start_dot = i;
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot != -1 {
            pre_dot_state = -1;
        }
        i -= 1;
    }
    if start_dot == -1
        || end == -1
        || pre_dot_state == 0
        || (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)
    {
        return String::new();
    }
    text(&p[start_dot as usize..end as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On Windows Node resolves a drive-relative path against that drive's own working
    /// directory (`process.env["=D:"]`) when there is one, and against the drive's root when
    /// the process's working directory is on another drive. Off Windows Node never reads it, so
    /// the recorded cases can't show this branch.
    #[test]
    fn a_drive_relative_path_uses_that_drives_working_directory() {
        let drives = |d: &str| (d == "D:").then(|| "D:\\dcwd\\sub".to_string());
        assert_eq!(
            resolve_with(&["D:x"], "C:\\work", &drives),
            "D:\\dcwd\\sub\\x"
        );
        assert_eq!(resolve_with(&["E:x"], "C:\\work", &drives), "E:\\x");
        assert_eq!(resolve_with(&["c:x"], "C:\\work", &drives), "c:\\work\\x");
    }
}
