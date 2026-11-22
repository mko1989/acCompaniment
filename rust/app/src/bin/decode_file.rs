//! Decodes one file with the Rust decoder (B4) for `rust/scripts/compare-decode.js`:
//! `decode-file <path> <sampleRate> <out.f32>` writes the interleaved stereo f32 samples and
//! prints `{"via", "frames", "durationSec"}` or `{"error"}`.

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (path, rate, out) = (&args[1], args[2].parse::<u32>().unwrap_or(48000), &args[3]);
    match accompaniment::audio::decode::decode_to_float32(path, rate) {
        Ok(d) => {
            let mut bytes = Vec::with_capacity(d.samples.len() * 4);
            for s in &d.samples {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            std::fs::File::create(out)
                .and_then(|mut f| f.write_all(&bytes))
                .expect("writing the samples");
            println!(
                "{}",
                serde_json::json!({ "via": d.via, "frames": d.samples.len() / d.channels,
                    "durationSec": d.duration_sec })
            );
        }
        Err(e) => println!("{}", serde_json::json!({ "error": e })),
    }
}
