//! multer's `diskStorage().single(field)` (rust/research/http-websocket.md §1.6, §3 trap 10): the
//! one file of `field` streamed to `<tempDir>/uploads/<uuid><ext>` with a size limit and a file
//! filter, the text fields collected as `req.body`, and multer's errors.

use axum::body::Body;
use axum::http::{HeaderMap, header};
use futures_util::StreamExt;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt;

use crate::core::{jsv, nodefs as nfs};

/// busboy's default limit for a text field.
const FIELD_LIMIT: usize = 1024 * 1024;

pub struct Upload {
    /// Where the file was written.
    pub path: String,
    /// The name the client sent (UTF-8, as `originalNameOf` makes it).
    pub original_name: String,
}

pub enum UploadError {
    /// `LIMIT_FILE_SIZE`.
    TooLarge,
    /// Any other multer error, with its message.
    Other(String),
}

pub struct Received {
    pub file: Option<Upload>,
    pub fields: Map<String, Value>,
}

pub struct Rules<'a> {
    pub field: &'a str,
    pub upload_dir: String,
    pub max_bytes: u64,
    /// `fileFilter`: allowed lowercased extensions (`None` = any).
    pub allowed: Option<&'a [&'a str]>,
    /// The stored name's extension: the original's (lowercased) or a fixed one (`.zip`).
    pub fixed_ext: Option<&'a str>,
}

/// Reads a multipart body. A request that isn't multipart is skipped, as multer does: no file.
pub async fn receive(
    headers: &HeaderMap,
    body: Body,
    rules: &Rules<'_>,
) -> Result<Received, UploadError> {
    let mut received = Received {
        file: None,
        fields: Map::new(),
    };
    let boundary = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|ct| {
            ct.split(';')
                .next()
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("multipart/form-data"))
        })
        .and_then(|ct| multer::parse_boundary(ct).ok());
    let Some(boundary) = boundary else {
        return Ok(received);
    };
    let mut mp = multer::Multipart::new(body.into_data_stream(), boundary);
    let mut failure: Option<UploadError> = None;
    loop {
        let field = match mp.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                failure = Some(UploadError::Other(busboy_message(&e)));
                break;
            }
        };
        let name = field.name().unwrap_or("").to_string();
        let file_name = field.file_name().map(str::to_string);
        let Some(file_name) = file_name else {
            // A text field.
            let mut text = Vec::new();
            let mut field = field;
            loop {
                match field.chunk().await {
                    Ok(Some(c)) => {
                        text.extend_from_slice(&c);
                        if text.len() > FIELD_LIMIT {
                            failure = Some(UploadError::Other("Field value too long".into()));
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        failure = Some(UploadError::Other(busboy_message(&e)));
                        break;
                    }
                }
            }
            if failure.is_some() {
                break;
            }
            let v = Value::String(String::from_utf8_lossy(&text).into_owned());
            match received.fields.get_mut(&name) {
                Some(Value::Array(a)) => a.push(v),
                Some(prev) => {
                    let first = prev.take();
                    *prev = Value::Array(vec![first, v]);
                }
                None => {
                    received.fields.insert(name, v);
                }
            }
            continue;
        };
        if name != rules.field || received.file.is_some() {
            failure = Some(UploadError::Other("Unexpected file field".into()));
            break;
        }
        let ext = nfs::extname(&file_name).to_lowercase();
        if let Some(allowed) = rules.allowed
            && !allowed.contains(&ext.as_str())
        {
            failure = Some(UploadError::Other(format!(
                "Unsupported file format: {ext}"
            )));
            break;
        }
        if nfs::ensure_dir(&rules.upload_dir).is_err() {
            failure = Some(UploadError::Other(format!(
                "ENOENT: no such file or directory, mkdir '{}'",
                rules.upload_dir
            )));
            break;
        }
        let stored_ext = rules.fixed_ext.map_or(ext, str::to_string);
        let path = nfs::join2(
            &rules.upload_dir,
            &format!("{}{stored_ext}", jsv::random_uuid()),
        );
        let mut out = match tokio::fs::File::create(&path).await {
            Ok(f) => f,
            Err(e) => {
                failure = Some(UploadError::Other(e.to_string()));
                break;
            }
        };
        let mut written: u64 = 0;
        let mut field = field;
        loop {
            match field.chunk().await {
                Ok(Some(c)) => {
                    written += c.len() as u64;
                    if written > rules.max_bytes {
                        failure = Some(UploadError::TooLarge);
                        break;
                    }
                    if let Err(e) = out.write_all(&c).await {
                        failure = Some(UploadError::Other(e.to_string()));
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    failure = Some(UploadError::Other(busboy_message(&e)));
                    break;
                }
            }
        }
        let _ = out.flush().await;
        drop(out);
        if failure.is_some() {
            // multer removes the partial file.
            let _ = tokio::fs::remove_file(&path).await;
            break;
        }
        received.file = Some(Upload {
            path,
            original_name: file_name,
        });
    }
    if let Some(f) = failure {
        // Keep reading what the client still sends, so it sees the answer instead of a reset.
        while let Ok(Some(mut field)) = mp.next_field().await {
            while let Ok(Some(_)) = field.chunk().await {}
        }
        if let Some(file) = &received.file {
            let _ = tokio::fs::remove_file(&file.path).await;
        }
        return Err(f);
    }
    Ok(received)
}

/// busboy's wording for the common malformed-body errors (error text is free, ADR-005).
fn busboy_message(e: &multer::Error) -> String {
    match e {
        multer::Error::IncompleteStream | multer::Error::IncompleteFieldData { .. } => {
            "Unexpected end of form".into()
        }
        multer::Error::IncompleteHeaders | multer::Error::ReadHeaderFailed(_) => {
            "Malformed part header".into()
        }
        other => other.to_string(),
    }
}

/// Drains a body nobody reads (a non-multipart request to an upload route), so the client gets
/// the answer.
pub async fn drain(body: Body) {
    let mut s = body.into_data_stream();
    while let Some(Ok(_)) = s.next().await {}
}
