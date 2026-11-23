//! What Express does around the routes (rust/research/http-websocket.md §1, §3): JSON responses,
//! finalhandler's 404 and error pages, `cors({ origin: true, credentials: true })`, body-parser
//! (with server.js's `req.body ??= {}`), the `simple` query parser and `express.static`.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value};

use crate::core::jsv;

pub const JSON_LIMIT: usize = 50 * 1024 * 1024;

fn hv(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// `res.status(status).json(value)`.
pub fn json(status: u16, value: &Value) -> Response {
    let mut r = Response::new(Body::from(jsv::stringify(value)));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    r
}

/// `{ success: false, error }` with a status.
pub fn fail(status: u16, error: &str) -> Response {
    json(
        status,
        &serde_json::json!({ "success": false, "error": error }),
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The `encodeurl` package: percent-encodes what isn't allowed in a URL, keeps `%xx`.
fn encode_url(s: &str) -> String {
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let keep = c.is_ascii_alphanumeric() || b"!#$&'()*+,-./:;=?@[]_~".contains(&c);
        if c == b'%'
            && i + 2 < b.len() + 1
            && b.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
            && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
        {
            out.push('%');
        } else if keep {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
        i += 1;
    }
    out
}

/// finalhandler's page: `<pre>message</pre>` in its HTML document, with its security headers.
pub fn error_page(status: u16, message_html: &str) -> Response {
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{message_html}</pre>\n</body>\n</html>\n"
    );
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = r.headers_mut();
    h.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'"),
    );
    h.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    r
}

/// The unmatched-request 404: `Cannot <METHOD> <path>`.
pub fn not_found(method: &Method, raw_path: &str) -> Response {
    error_page(
        404,
        &format!("Cannot {method} {}", html_escape(&encode_url(raw_path))),
    )
}

/// An error that reached finalhandler. The original's page shows `err.stack`; this shows the
/// status text, as finalhandler does in production (ADR-017: only status and type must match).
pub fn status_page(status: u16) -> Response {
    let text = StatusCode::from_u16(status)
        .ok()
        .and_then(|s| s.canonical_reason())
        .unwrap_or("Error");
    error_page(status, &html_escape(text))
}

/// `cors({ origin: true, credentials: true })`: any OPTIONS is answered here.
pub fn cors_preflight(req_headers: &HeaderMap) -> Response {
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::NO_CONTENT;
    let h = r.headers_mut();
    if let Some(origin) = req_headers.get(header::ORIGIN) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
    h.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,HEAD,PUT,PATCH,POST,DELETE"),
    );
    if let Some(asked) = req_headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked.clone());
    }
    h.insert(
        header::VARY,
        HeaderValue::from_static("Origin, Access-Control-Request-Headers"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    r
}

/// The CORS headers cors adds to every other response.
pub fn add_cors(req_headers: &HeaderMap, r: &mut Response) {
    let h = r.headers_mut();
    if let Some(origin) = req_headers.get(header::ORIGIN) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
    h.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    let vary = match h.get(header::VARY).and_then(|v| v.to_str().ok()) {
        Some(v)
            if !v
                .split(',')
                .any(|p| p.trim().eq_ignore_ascii_case("origin")) =>
        {
            format!("{v}, Origin")
        }
        Some(v) => v.to_string(),
        None => "Origin".to_string(),
    };
    h.insert(header::VARY, hv(&vary));
}

/// How body-parser left `req.body`.
pub enum Parsed {
    /// A JSON or urlencoded body, or `{}` (no body / another type).
    Body(Value),
    /// The request still has its body (multipart and other types): routes that read one stream it.
    Untouched,
    /// body-parser failed: finalhandler's page with this status.
    Error(u16),
}

fn media_type(headers: &HeaderMap) -> Option<(String, Option<String>)> {
    let ct = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    let mut parts = ct.split(';');
    let ty = parts.next()?.trim().to_ascii_lowercase();
    let charset = parts.find_map(|p| {
        let (k, v) = p.split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| v.trim().trim_matches('"').to_ascii_lowercase())
    });
    Some((ty, charset))
}

/// Whether body-parser would read this request's body (json or urlencoded).
pub fn wants_body_parser(headers: &HeaderMap) -> bool {
    matches!(
        media_type(headers).map(|(t, _)| t).as_deref(),
        Some("application/json" | "application/x-www-form-urlencoded")
    )
}

/// body-parser 2 on a body already read (the caller enforces `JSON_LIMIT` → 413).
pub fn parse_body(headers: &HeaderMap, bytes: &[u8]) -> Parsed {
    let Some((ty, charset)) = media_type(headers) else {
        return Parsed::Body(Value::Object(Map::new()));
    };
    if bytes.is_empty() {
        return Parsed::Body(Value::Object(Map::new()));
    }
    if let Some(enc) = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        && !enc.eq_ignore_ascii_case("identity")
    {
        // gzip/deflate/br would be inflated by body-parser; no client sends them (gap).
        return Parsed::Error(415);
    }
    match ty.as_str() {
        "application/json" => {
            if charset.as_deref().is_some_and(|c| !c.starts_with("utf-")) {
                return Parsed::Error(415);
            }
            let text = String::from_utf8_lossy(bytes);
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            // `strict`: the first non-whitespace character must open an object or an array.
            let first = text
                .chars()
                .find(|c| !matches!(c, ' ' | '\t' | '\n' | '\r'));
            if !matches!(first, Some('{' | '[')) {
                return Parsed::Error(400);
            }
            match jsv::parse_str(text) {
                Ok(v) => Parsed::Body(v),
                Err(_) => Parsed::Error(400),
            }
        }
        "application/x-www-form-urlencoded" => {
            if charset.as_deref().is_some_and(|c| c != "utf-8") {
                return Parsed::Error(415);
            }
            // `extended` qs parsing; nested `a[b]` keys stay flat (no client sends urlencoded).
            let mut o = Map::new();
            for (k, v) in form_urlencoded::parse(bytes) {
                let (k, v) = (k.into_owned(), Value::String(v.into_owned()));
                match o.get_mut(&k) {
                    Some(Value::Array(a)) => a.push(v),
                    Some(prev) => {
                        let first = prev.take();
                        *prev = Value::Array(vec![first, v]);
                    }
                    None => {
                        o.insert(k, v);
                    }
                }
            }
            let mut v = Value::Object(o);
            if let Value::Object(o) = &mut v {
                jsv::js_order(o);
            }
            Parsed::Body(v)
        }
        _ => Parsed::Untouched,
    }
}

/// `req.query` with Express 5's `simple` parser (`node:querystring`): a repeated key is an array.
pub fn parse_query(query: Option<&str>) -> Map<String, Value> {
    let mut o = Map::new();
    for (k, v) in form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
        let (k, v) = (k.into_owned(), Value::String(v.into_owned()));
        match o.get_mut(&k) {
            Some(Value::Array(a)) => a.push(v),
            Some(prev) => {
                let first = prev.take();
                *prev = Value::Array(vec![first, v]);
            }
            None => {
                o.insert(k, v);
            }
        }
    }
    o
}

/// `parseInt(value, 10)`, NaN as `None` (the routes then use `|| 0`).
pub fn parse_int(v: Option<&Value>) -> Option<f64> {
    let s = jsv::to_js_string(v?);
    let t = s.trim_start_matches(jsv::is_js_space);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let n: f64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// `Math.min(Math.max(parseInt(q.limit, 10) || 0, 0), 500)` and the offset.
pub fn pagination(q: &Map<String, Value>) -> (f64, f64) {
    let lim = parse_int(q.get("limit"))
        .filter(|n| *n != 0.0)
        .unwrap_or(0.0);
    let off = parse_int(q.get("offset"))
        .filter(|n| *n != 0.0)
        .unwrap_or(0.0);
    (lim.clamp(0.0, 500.0), off.max(0.0))
}

/// `decodeURIComponent`, `None` on a malformed sequence.
pub fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut bytes = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

// --- express.static ----------------------------------------------------------------------

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// The decoded request path's segments, or `None` for one that leaves the root (send's 403).
/// On Windows `\\` separates too, as Node's `path` there treats it (WO-039), and a segment with a
/// `:` (a drive, `C:`) is refused: pushed onto the root it would replace it.
fn static_segments(decoded: &str, windows: bool) -> Option<Vec<&str>> {
    let segments: Vec<&str> = if windows {
        decoded.split(['/', '\\']).collect()
    } else {
        decoded.split('/').collect()
    };
    if segments.contains(&"..") || (windows && segments.iter().any(|s| s.contains(':'))) {
        return None;
    }
    Some(segments)
}

/// What `express.static(root)` does with a GET/HEAD: a response, or `None` to fall through
/// (missing files, dotfiles, `..`, and every other client error: `fallthrough: true`).
pub async fn serve_static(root: &Path, raw_path: &str, headers: &HeaderMap) -> Option<Response> {
    let decoded = decode_component(raw_path)?;
    if decoded.contains('\0') {
        return None;
    }
    let Some(segments) = static_segments(&decoded, cfg!(windows)) else {
        return None; // send: 403, which falls through
    };
    if segments.iter().any(|s| s.starts_with('.') && !s.is_empty()) {
        return None; // dotfiles: 'ignore'
    }
    let mut file: PathBuf = root.to_path_buf();
    for s in segments.iter().filter(|s| !s.is_empty()) {
        file.push(s);
    }
    let meta = tokio::fs::metadata(&file).await.ok()?;
    if meta.is_dir() {
        if !raw_path.ends_with('/') {
            // serve-static's redirect to the directory with a slash.
            let location = format!("{raw_path}/");
            let loc_html = html_escape(&encode_url(&location));
            let body = format!(
                "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to {loc_html}</pre>\n</body>\n</html>\n"
            );
            let mut r = Response::new(Body::from(body));
            *r.status_mut() = StatusCode::MOVED_PERMANENTLY;
            let h = r.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            h.insert(
                HeaderName::from_static("content-security-policy"),
                HeaderValue::from_static("default-src 'none'"),
            );
            h.insert(
                HeaderName::from_static("x-content-type-options"),
                HeaderValue::from_static("nosniff"),
            );
            h.insert(header::LOCATION, hv(&encode_url(&location)));
            return Some(r);
        }
        file.push("index.html");
        let m = tokio::fs::metadata(&file).await.ok()?;
        if !m.is_file() {
            return None;
        }
        return send_file(&file, &m, headers).await;
    }
    if !meta.is_file() {
        return None;
    }
    send_file(&file, &meta, headers).await
}

/// `send`: the file with its headers, or 304.
pub async fn send_file(
    file: &Path,
    meta: &std::fs::Metadata,
    headers: &HeaderMap,
) -> Option<Response> {
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let mtime_ms = jsv::system_time_ms(mtime).floor();
    let etag = format!("W/\"{:x}-{:x}\"", meta.len(), mtime_ms as i64);
    let last_modified = httpdate::fmt_http_date(mtime);
    let fresh = match headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        Some(inm) => {
            let strip = |t: &str| t.trim().trim_start_matches("W/").to_string();
            inm.trim() == "*" || inm.split(',').any(|t| strip(t) == strip(&etag))
        }
        None => headers
            .get(header::IF_MODIFIED_SINCE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| httpdate::parse_http_date(v).ok())
            .is_some_and(|since| {
                mtime
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs())
                    <= since
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .ok()
                        .map(|d| d.as_secs())
            }),
    };
    let mut r = if fresh {
        let mut r = Response::new(Body::empty());
        *r.status_mut() = StatusCode::NOT_MODIFIED;
        r
    } else {
        let bytes = tokio::fs::read(file).await.ok()?;
        let mut r = Response::new(Body::from(bytes));
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(content_type(file)),
        );
        r
    };
    let h = r.headers_mut();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=0"),
    );
    h.insert(header::LAST_MODIFIED, hv(&last_modified));
    h.insert(header::ETAG, hv(&etag));
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_paths_cannot_leave_the_root_on_windows() {
        // WO-039: `/..%5c..%5cWindows%5cwin.ini` decodes to a backslash path.
        assert_eq!(static_segments("/..\\..\\Windows\\win.ini", true), None);
        assert_eq!(static_segments("/C:\\Windows\\win.ini", true), None);
        assert_eq!(static_segments("/assets/C:x.png", true), None);
        assert_eq!(
            static_segments("/assets\\app.js", true),
            Some(vec!["", "assets", "app.js"])
        );
        // Elsewhere a backslash is an ordinary character in a file name, as in Node.
        assert_eq!(static_segments("/..\\x", false), Some(vec!["", "..\\x"]));
        assert_eq!(static_segments("/a/../b", false), None);
    }
}
