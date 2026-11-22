//! Node's `path` (POSIX) and the `fs-extra` calls the original makes, with Node's error
//! messages, plus `writeJsonAtomic` (`src/backend/utils/atomicWrite.js`).
//!
//! Paths stay strings, exactly as the original builds them: a relative `ACCOMPANIMENT_DATA_DIR`
//! gives relative paths in metadata records, as it does in Node. Windows paths are not handled
//! (POSIX only, like the recording).

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use serde_json::Value;

use super::jsv;

const SEP: u8 = b'/';

// ---- path -------------------------------------------------------------------------------------

fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let p = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let n = p.len();
    for i in 0..=n {
        if i < n {
            code = p[i];
        } else if code == SEP {
            break;
        } else {
            code = SEP;
        }
        if code == SEP {
            let ii = i as isize;
            if last_slash == ii - 1 || dots == 1 {
                // nothing
            } else if dots == 2 {
                let rb = res.as_bytes();
                if rb.len() < 2
                    || last_segment_length != 2
                    || rb[rb.len() - 1] != b'.'
                    || rb[rb.len() - 2] != b'.'
                {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                // res.length - 1 - res.lastIndexOf('/'), with lastIndexOf -1
                                last_segment_length = match res.rfind('/') {
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
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let seg = &path[(last_slash + 1) as usize..i];
                if res.is_empty() {
                    res.push_str(seg);
                } else {
                    res.push('/');
                    res.push_str(seg);
                }
                last_segment_length = (ii - last_slash - 1) as usize;
            }
            last_slash = ii;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

/// `path.resolve(...paths)`.
pub fn resolve(paths: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    let mut i = paths.len() as isize - 1;
    while i >= -1 && !absolute {
        let p = if i >= 0 {
            paths[i as usize]
        } else {
            cwd.as_str()
        };
        i -= 1;
        if p.is_empty() {
            continue;
        }
        resolved = format!("{p}/{resolved}");
        absolute = p.starts_with('/');
    }
    let norm = normalize_string(&resolved, !absolute);
    if absolute {
        format!("/{norm}")
    } else if norm.is_empty() {
        ".".into()
    } else {
        norm
    }
}

pub fn resolve1(p: &str) -> String {
    resolve(&[p])
}

/// `path.normalize(path)`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut p = normalize_string(path, !absolute);
    if p.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        p.push('/');
    }
    if absolute { format!("/{p}") } else { p }
}

/// `path.join(...paths)`.
pub fn join(paths: &[&str]) -> String {
    let parts: Vec<&str> = paths.iter().copied().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    normalize(&parts.join("/"))
}

pub fn join2(a: &str, b: &str) -> String {
    join(&[a, b])
}

pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// `path.relative(from, to)`.
pub fn relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve1(from);
    let to = resolve1(to);
    if from == to {
        return String::new();
    }
    let f = from.as_bytes();
    let t = to.as_bytes();
    let from_start = 1;
    let from_end = f.len();
    let from_len = from_end - from_start;
    let to_start = 1;
    let to_len = t.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0;
    while i < length {
        let fc = f[from_start + i];
        if fc != t[to_start + i] {
            break;
        } else if fc == SEP {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if t[to_start + i] == SEP {
                return to[to_start + i + 1..].to_string();
            }
            if i == 0 {
                return to[to_start + i..].to_string();
            }
        } else if from_len > length {
            if f[from_start + i] == SEP {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || f[j] == SEP {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        j += 1;
    }
    let tail_start = (to_start as isize + last_common_sep) as usize;
    format!("{out}{}", &to[tail_start..])
}

/// `path.dirname(path)`.
pub fn dirname(path: &str) -> String {
    let p = path.as_bytes();
    if p.is_empty() {
        return ".".into();
    }
    let has_root = p[0] == SEP;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = p.len() - 1;
    while i >= 1 {
        if p[i] == SEP {
            if !matched_slash {
                end = i as isize;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    path[..end as usize].to_string()
}

/// `path.basename(path, suffix?)`.
pub fn basename(path: &str, suffix: Option<&str>) -> String {
    let p = path.as_bytes();
    let mut start = 0usize;
    let mut end: isize = -1;
    let mut matched_slash = true;
    if let Some(sfx) = suffix.filter(|s| !s.is_empty() && s.len() <= path.len()) {
        if sfx == path {
            return String::new();
        }
        let s = sfx.as_bytes();
        let mut ext_idx: isize = s.len() as isize - 1;
        let mut first_non_slash_end: isize = -1;
        let mut i = p.len() as isize - 1;
        while i >= 0 {
            let code = p[i as usize];
            if code == SEP {
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
                    if code == s[ext_idx as usize] {
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
        return slice_bytes(path, start, end.max(start as isize) as usize);
    }
    let mut i = p.len() as isize - 1;
    while i >= 0 {
        if p[i as usize] == SEP {
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
    slice_bytes(path, start, end as usize)
}

fn slice_bytes(s: &str, start: usize, end: usize) -> String {
    String::from_utf8_lossy(&s.as_bytes()[start..end]).into_owned()
}

/// `path.extname(path)`.
pub fn extname(path: &str) -> String {
    let p = path.as_bytes();
    let mut start_dot: isize = -1;
    let mut start_part: isize = 0;
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut pre_dot_state = 0;
    let mut i = p.len() as isize - 1;
    while i >= 0 {
        let code = p[i as usize];
        if code == SEP {
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
        if code == b'.' {
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
    slice_bytes(path, start_dot as usize, end as usize)
}

// ---- errors -----------------------------------------------------------------------------------

/// A Node fs error: `ENOENT: no such file or directory, stat '/x'`.
#[derive(Debug, Clone)]
pub struct NodeError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for NodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<NodeError> for String {
    fn from(e: NodeError) -> String {
        e.message
    }
}

fn code_of(e: &io::Error) -> (&'static str, &'static str) {
    use io::ErrorKind as K;
    match e.kind() {
        K::NotFound => ("ENOENT", "no such file or directory"),
        K::PermissionDenied => ("EACCES", "permission denied"),
        K::AlreadyExists => ("EEXIST", "file already exists"),
        K::NotADirectory => ("ENOTDIR", "not a directory"),
        K::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        K::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        K::CrossesDevices => ("EXDEV", "cross-device link not permitted"),
        K::StorageFull => ("ENOSPC", "no space left on device"),
        K::InvalidFilename => ("ENAMETOOLONG", "name too long"),
        _ => ("UNKNOWN", "unknown error"),
    }
}

pub fn err(e: &io::Error, syscall: &str, path: &str) -> NodeError {
    let (code, desc) = code_of(e);
    NodeError {
        code,
        message: format!("{code}: {desc}, {syscall} '{path}'"),
    }
}

pub fn err2(e: &io::Error, syscall: &str, from: &str, to: &str) -> NodeError {
    let (code, desc) = code_of(e);
    NodeError {
        code,
        message: format!("{code}: {desc}, {syscall} '{from}' -> '{to}'"),
    }
}

pub fn plain(message: impl Into<String>) -> NodeError {
    NodeError {
        code: "",
        message: message.into(),
    }
}

pub type NResult<T> = Result<T, NodeError>;

// ---- fs-extra ---------------------------------------------------------------------------------

/// `fs.ensureDir` (`mkdir -p`).
pub fn ensure_dir(dir: &str) -> NResult<()> {
    match fs::create_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) => Err(err(&e, "mkdir", dir)),
    }
}

/// `fs.pathExists`.
pub fn path_exists(p: &str) -> bool {
    fs::metadata(p).is_ok()
}

/// `fs.remove` (`rm -rf`; nothing if missing).
pub fn remove(p: &str) -> NResult<()> {
    match fs::symlink_metadata(p) {
        Err(_) => Ok(()),
        Ok(m) if m.is_dir() => fs::remove_dir_all(p).map_err(|e| err(&e, "rm", p)),
        Ok(_) => match fs::remove_file(p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(err(&e, "rm", p)),
        },
    }
}

/// `fs.readdir(dir)`: names, sorted as libuv sorts them on Unix (byte order).
pub fn readdir(dir: &str) -> NResult<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map_err(|e| err(&e, "scandir", dir))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Ok(names)
}

/// A `Dirent`: symlinks are neither files nor directories.
pub struct Dirent {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
}

/// `fs.readdir(dir, { withFileTypes: true })`.
pub fn readdir_types(dir: &str) -> NResult<Vec<Dirent>> {
    let mut out: Vec<Dirent> = fs::read_dir(dir)
        .map_err(|e| err(&e, "scandir", dir))?
        .filter_map(|e| e.ok())
        .map(|e| {
            let ft = e.file_type().ok();
            Dirent {
                name: e.file_name().to_string_lossy().into_owned(),
                is_file: ft.is_some_and(|t| t.is_file()),
                is_dir: ft.is_some_and(|t| t.is_dir()),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub struct Stat {
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub mtime_ms: f64,
    pub birthtime_ms: f64,
}

/// `fs.stat`.
pub fn stat(p: &str) -> NResult<Stat> {
    let m = fs::metadata(p).map_err(|e| err(&e, "stat", p))?;
    let ms = |t: io::Result<SystemTime>| t.map(jsv::system_time_ms).unwrap_or(0.0);
    Ok(Stat {
        size: m.len(),
        is_file: m.is_file(),
        is_dir: m.is_dir(),
        mtime_ms: ms(m.modified()),
        birthtime_ms: ms(m.created()),
    })
}

/// A Node `Date` from `stats.mtime` as it serializes: whole milliseconds, ISO.
pub fn date_json(ms: f64) -> Value {
    Value::String(jsv::iso_from_ms(ms))
}

pub fn read_file(p: &str) -> NResult<Vec<u8>> {
    fs::read(p).map_err(|e| err(&e, "open", p))
}

/// `fs.copy(src, dest)`: files or whole directories, overwriting; times not kept.
pub fn copy(src: &str, dest: &str) -> NResult<()> {
    let m = fs::symlink_metadata(src).map_err(|e| err(&e, "lstat", src))?;
    if m.is_dir() {
        ensure_dir(dest)?;
        for name in readdir(src)? {
            copy(&join2(src, &name), &join2(dest, &name))?;
        }
        Ok(())
    } else {
        if let Some(parent) = Path::new(dest).parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| err2(&e, "copyfile", src, dest))
    }
}

/// `fs.move(src, dest, { overwrite })`.
pub fn move_path(src: &str, dest: &str, overwrite: bool) -> NResult<()> {
    if !overwrite && fs::symlink_metadata(dest).is_ok() && resolve1(src) != resolve1(dest) {
        return Err(plain("dest already exists."));
    }
    if overwrite && fs::symlink_metadata(dest).is_ok() && resolve1(src) != resolve1(dest) {
        remove(dest)?;
    }
    if let Some(parent) = Path::new(dest).parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            copy(src, dest)?;
            remove(src)
        }
        Err(e) => Err(err2(&e, "rename", src, dest)),
    }
}

/// `fs.emptyDir`.
pub fn empty_dir(dir: &str) -> NResult<()> {
    match readdir(dir) {
        Ok(names) => {
            for n in names {
                remove(&join2(dir, &n))?;
            }
            Ok(())
        }
        Err(_) => ensure_dir(dir),
    }
}

pub fn write_bytes(p: &str, bytes: &[u8]) -> NResult<()> {
    fs::write(p, bytes).map_err(|e| err(&e, "open", p))
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `writeJsonAtomic`: `JSON.stringify(data, null, 2)` to `<file>.tmp.<pid>.<ms>.<n>`, fsync,
/// rename over the file.
pub fn write_json_atomic(file: &str, data: &Value) -> NResult<()> {
    let content = jsv::stringify_pretty(data);
    ensure_dir(&dirname(file))?;
    let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    let tmp = format!(
        "{file}.tmp.{}.{}.{n}",
        std::process::id(),
        jsv::now_ms() as u64
    );
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| err(&e, "open", &tmp))?;
        f.write_all(content.as_bytes())
            .map_err(|e| err(&e, "write", &tmp))?;
        f.sync_all().map_err(|e| err(&e, "fsync", &tmp))?;
    }
    fs::rename(&tmp, file).map_err(|e| err2(&e, "rename", &tmp, file))
}

/// `fs.readFile(p, 'utf-8')` then `JSON.parse`; the error is the message the original reports.
pub fn read_json(p: &str) -> NResult<Value> {
    let bytes = read_file(p)?;
    jsv::parse(&bytes).map_err(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_path() {
        assert_eq!(extname("a."), ".");
        assert_eq!(extname(".mp3"), "");
        assert_eq!(extname("..mp3"), ".mp3");
        assert_eq!(extname("x..mp3"), ".mp3");
        assert_eq!(basename("/a/b/Song.mp3", Some(".mp3")), "Song");
        assert_eq!(basename("dir/", None), "dir");
        assert_eq!(normalize("a/../../b/./c/"), "../b/c/");
        assert_eq!(join(&["a", "", "/b", ".."]), "a");
        assert_eq!(relative("/data/audio", "/data/audio/x/y.wav"), "x/y.wav");
        assert_eq!(relative("/data/audio", "/data/other"), "../other");
        assert_eq!(dirname("/a/b/c"), "/a/b");
        assert_eq!(dirname("a"), ".");
        assert_eq!(resolve(&["/x", "../y", "z"]), "/y/z");
    }
}
