//! The Rust port of `src/backend/utils/idValidation.js` (through `rust/shims/id-validation/`).
//!
//! The original is the regex
//! `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`. Without the
//! `u` flag, JS `/i` folds ASCII letters only (a non-ASCII character never matches `[a-f]`), and
//! `$` without `m` matches only at the very end, so a trailing newline fails. Checking the bytes
//! directly gives exactly that, with no regex engine's Unicode case folding in between.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const HYPHENS: [usize; 4] = [8, 13, 18, 23];

/// Port of `isValidUuid` (`src/backend/utils/idValidation.js:3`): an RFC 4122 v1-v5 UUID, any case.
pub fn is_valid_uuid(id: String) -> Result<bool, String> {
    Ok(is_uuid(&id))
}

/// Port of `validateUuidOrError` (`src/backend/utils/idValidation.js:7`).
pub fn validate_uuid_or_error(id: String, label: String) -> Result<Value, String> {
    Ok(if is_uuid(&id) {
        json!({ "valid": true })
    } else {
        json!({ "valid": false, "error": format!("Invalid {label}: must be a UUID") })
    })
}

/// The check itself, for Rust callers.
pub fn is_uuid(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            _ if HYPHENS.contains(&i) => c == b'-',
            14 => (b'1'..=b'5').contains(&c),
            19 => matches!(c.to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b'),
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_variants() {
        assert!(is_uuid("d86f0e6c-af67-4918-964d-60f975548940"));
        assert!(is_uuid("D86F0E6C-AF67-5918-B64D-60F975548940"));
        assert!(
            !is_uuid("d86f0e6c-af67-6918-964d-60f975548940"),
            "v6 is not 1-5"
        );
        assert!(
            !is_uuid("d86f0e6c-af67-4918-c64d-60f975548940"),
            "variant c"
        );
        assert!(!is_uuid("00000000-0000-0000-0000-000000000000"), "nil");
    }

    #[test]
    fn no_trailing_newline_or_lookalikes() {
        assert!(!is_uuid("d86f0e6c-af67-4918-964d-60f975548940\n"));
        assert!(!is_uuid("d86f0e6c-af67-4918-964d-60\u{FF19}75548940"));
        assert!(!is_uuid("d86\u{212A}0e6c-af67-4918-964d-60f975548940"));
    }

    #[test]
    fn error_message() {
        assert_eq!(
            validate_uuid_or_error("x".into(), "cueId".into()).unwrap(),
            json!({ "valid": false, "error": "Invalid cueId: must be a UUID" })
        );
    }
}
