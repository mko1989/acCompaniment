//! Every JSON file the original wrote (the recording's seed data dir) reads and writes back
//! byte for byte: `JSON.parse` + `JSON.stringify(x, null, 2)` (ADR-006).

use std::path::Path;

use accompaniment::core::jsv;

fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push(p);
        }
    }
}

#[test]
fn seed_json_round_trips_byte_for_byte() {
    let seed = Path::new(env!("CARGO_MANIFEST_DIR")).join("../app-fixtures/data");
    let mut files = Vec::new();
    walk(&seed, &mut files);
    assert!(files.len() > 5, "seed not found at {}", seed.display());
    for f in files {
        let bytes = std::fs::read(&f).unwrap_or_default();
        let value = jsv::parse(&bytes).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        assert_eq!(
            jsv::stringify_pretty(&value).as_bytes(),
            &bytes[..],
            "{}",
            f.display()
        );
    }
}
